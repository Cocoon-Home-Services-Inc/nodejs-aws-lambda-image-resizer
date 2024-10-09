"use strict";

const AWS = require("aws-sdk");
const Sharp = require("sharp");

const BUCKET = process.env.BUCKET;
const S3 = new AWS.S3({ signatureVersion: "v4" });

const FIT_OPTIONS = [
  "cover", // Preserving aspect ratio, ensure the image covers both provided dimensions by cropping/clipping to fit. (default)
  "contain", // Preserving aspect ratio, contain within both provided dimensions using "letterboxing" where necessary.
  "fill", // Ignore the aspect ratio of the input and stretch to both provided dimensions.
  "inside", // Preserving aspect ratio, resize the image to be as large as possible while ensuring its dimensions are less than or equal to both those specified.
  "outside", // Preserving aspect ratio, resize the image to be as small as possible while ensuring its dimensions are greater than or equal to both those specified.
];
const RESPONSE_TYPES = {
  FILE: "file",
  JSON: "json",
};
const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/gif",
  "image/png",
  "image/svg+xml",
  "image/tiff",
  "image/bmp",
];
const UNSUPPORTED_SHARP_MIME_TYPES = ["image/bmp"];
const DEFAULT_CACHE_HEADER = "public, max-age=86400";

function getResource(resourcePath) {
  let params = { Bucket: BUCKET, Key: resourcePath };
  return new Promise((resolve, reject) => {
    S3.getObject(params, (err, data) => {
      if (err) return resolve(false);
      if (data) return resolve(data);
    });
  });
}

exports.handler = async (event) => {
  try {
    const { pathParameters, queryStringParameters } = event;

    const originalImageKey =
      pathParameters.proxy || pathParameters[Object.keys(pathParameters)[0]];
    const originalKeyParts = originalImageKey.split("/");
    const originalFilename = originalKeyParts.pop();
    const originalSubfolder = originalKeyParts.join("/");

    const resizeOptions = queryStringParameters?.options || "";
    const sizeAndAction = resizeOptions.split("_");
    const sizes = sizeAndAction[0].split("x");
    const action = sizeAndAction.length > 1 ? sizeAndAction[1] : "cover";
    const resizedSubfloder = [originalSubfolder, resizeOptions]
      .filter((i) => !!i)
      .join("/");
    const resizedKey = `${resizedSubfloder}/${originalFilename}`;

    const responseType = queryStringParameters
      ? queryStringParameters.response
      : RESPONSE_TYPES.JSON;

    if (action && FIT_OPTIONS.indexOf(action) === -1) {
      return {
        statusCode: 400,
        body:
          `Unknown Fit action parameter "${action}"\n` +
          `Available Fit actions: ${FIT_OPTIONS.join(", ")}.`,
        headers: { "Content-Type": "text/plain" },
      };
    }

    let existingImage = await getResource(
      resizeOptions ? resizedKey : originalImageKey
    );
    if (existingImage) {
      return responseType === RESPONSE_TYPES.FILE
        ? {
            statusCode: 200,
            body: Buffer.from(existingImage.Body).toString("base64"),
            isBase64Encoded: true,
            headers: {
              "Content-Type": existingImage.ContentType,
              "Cache-Control": DEFAULT_CACHE_HEADER,
            },
          }
        : {
            statusCode: 200,
            body: JSON.stringify({ resized: false, exists: true }),
            headers: {
              "Content-Type": "application/json",
              "Cache-Control": "private, nocache",
            },
          };
    }

    let originalImage = await getResource(originalImageKey);
    if (!originalImage) {
      return {
        statusCode: 404,
        body: `Resource not found. Could not find resource: ${originalImageKey}.`,
        headers: {
          "Content-Type": "text/plain",
          "Cache-Control": "private, nocache",
        },
      };
    }

    const originalImageMime = originalImage.ContentType;
    if (!ALLOWED_MIME_TYPES.includes(originalImageMime)) {
      return {
        statusCode: 400,
        body: `Unsupported MIME type: ${originalImageMime}. Supported types: ${ALLOWED_MIME_TYPES.join(
          ", "
        )}`,
        headers: {
          "Content-Type": "text/plain",
          "Cache-Control": "private, nocache",
        },
      };
    }

    if (UNSUPPORTED_SHARP_MIME_TYPES.includes(originalImageMime)) {
      return {
        statusCode: 200,
        body: Buffer.from(originalImage.Body).toString("base64"),
        isBase64Encoded: true,
        headers: {
          "Content-Type": originalImageMime,
          "Cache-Control": DEFAULT_CACHE_HEADER,
          Age: 0,
        },
      };
    }

    const width = sizes[0] === "auto" ? null : parseInt(sizes[0]);
    const height = sizes[1] === "auto" ? null : parseInt(sizes[1]);
    const fit = action || "cover";

    const result = await Sharp(originalImage.Body, { failOnError: false })
      .resize(width, height, { withoutEnlargement: true, fit })
      .rotate()
      .toBuffer();

    await S3.putObject({
      Body: result,
      Bucket: BUCKET,
      ContentType: originalImageMime,
      Key: resizedKey,
      CacheControl: DEFAULT_CACHE_HEADER,
    }).promise();

    if (responseType === RESPONSE_TYPES.FILE) {
      return {
        statusCode: 200,
        body: result.toString("base64"),
        isBase64Encoded: true,
        headers: {
          "Content-Type": originalImageMime,
          "Cache-Control": DEFAULT_CACHE_HEADER,
          Age: 0,
        },
      };
    } else {
      return {
        statusCode: 200,
        body: JSON.stringify({ resized: true, exists: false }),
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "private, nocache",
        },
      };
    }
  } catch (err) {
    console.log(err);
    return {
      statusCode: 500,
      body: "Internal server error",
      headers: { "Content-Type": "text/plain" },
    };
  }
};
