import { WebmBase } from "./WebmBase";

export class WebmFloat extends WebmBase<number, number> {
  constructor(name?: string, start = 0) {
    super(name, start);
  }

  override getType() {
    return "Float";
  }

  override updateBySource() {
    const source = this.source!;
    const view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    this.data = source.byteLength === 4 ? view.getFloat32(0) : view.getFloat64(0);
  }

  override updateByData() {
    const byteLength = this.source?.byteLength === 4 ? 4 : 8;
    this.source = new Uint8Array(byteLength);
    const view = new DataView(this.source.buffer);
    if (byteLength === 4) view.setFloat32(0, this.data!);
    else view.setFloat64(0, this.data!);
  }
}
