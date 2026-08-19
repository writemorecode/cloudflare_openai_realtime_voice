import { WebmContainer } from "./WebmContainer";

export class WebmFile extends WebmContainer {
  constructor(source: Uint8Array) {
    super("File");
    this.setSource(source);
  }

  override getType() {
    return "File";
  }

  toBlob(mimeType = "video/webm") {
    return new Blob([this.source!.buffer as ArrayBuffer], { type: mimeType });
  }

  static async fromBlob(blob: Blob) {
    return new WebmFile(new Uint8Array(await blob.arrayBuffer()));
  }
}
