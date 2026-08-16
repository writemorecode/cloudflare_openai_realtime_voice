/** Creates narrowly scoped, short-lived S3 GET URLs for private R2 recordings. */
import { AwsClient } from "aws4fetch";

const R2_REGION = "auto";
const PRESIGNED_URL_TTL_SECONDS = 15 * 60;
const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i;
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const RECORDING_KEY_PATTERN = /^conversations\/[0-9a-f-]+\/recording\.(?:webm|ogg|mp4)$/i;

export interface R2PresigningConfiguration {
  readonly accountId: string;
  readonly bucketName: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

export async function presignRecordingGet(
  configuration: R2PresigningConfiguration,
  objectKey: string,
): Promise<string> {
  validateConfiguration(configuration);
  if (!RECORDING_KEY_PATTERN.test(objectKey)) {
    throw new Error("Refusing to sign a non-recording R2 object key.");
  }

  const url = new URL(`https://${configuration.accountId}.r2.cloudflarestorage.com`);
  const encodedBucket = encodeURIComponent(configuration.bucketName);
  const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
  url.pathname = `/${encodedBucket}/${encodedKey}`;
  url.searchParams.set("X-Amz-Expires", String(PRESIGNED_URL_TTL_SECONDS));

  const client = new AwsClient({
    accessKeyId: configuration.accessKeyId,
    secretAccessKey: configuration.secretAccessKey,
    service: "s3",
    region: R2_REGION,
  });
  const request = await client.sign(url, { method: "GET", aws: { signQuery: true } });
  return request.url;
}

function validateConfiguration(configuration: R2PresigningConfiguration): void {
  if (!ACCOUNT_ID_PATTERN.test(configuration.accountId)) {
    throw new Error("The R2 account identifier is invalid.");
  }
  if (!BUCKET_PATTERN.test(configuration.bucketName)) {
    throw new Error("The R2 bucket name is invalid.");
  }
  if (configuration.accessKeyId.length === 0 || configuration.secretAccessKey.length === 0) {
    throw new Error("R2 S3 signing credentials are missing.");
  }
}
