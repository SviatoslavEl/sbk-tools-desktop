import { afterEach, describe, expect, it, vi } from "vitest";
import { previewImageFromBytes, releasePreviewImage } from "./scannerPreviewImages";

function png(width = 800, height = 1100) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const header = new DataView(bytes.buffer);
  header.setUint32(16, width); header.setUint32(20, height);
  return bytes;
}
afterEach(() => vi.restoreAllMocks());

describe("binary scanner preview images", () => {
  it("creates a small blob URL and budgets encoded plus decoded image memory", () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview");
    const image = previewImageFromBytes(png().buffer);
    expect(image).toEqual({ url: "blob:preview", retainedBytes: 24 + 800 * 1100 * 4 });
    const blob = create.mock.calls[0][0] as Blob;
    expect(blob.type).toBe("image/png"); expect(blob.size).toBe(24);
  });
  it("rejects wrong format and unsafe dimensions before allocating a blob", () => {
    const create = vi.spyOn(URL, "createObjectURL");
    for (const bytes of [new Uint8Array(4), new Uint8Array(24), png(0), png(1401), png(10, 1401)]) {
      expect(() => previewImageFromBytes(bytes)).toThrow();
    }
    expect(create).not.toHaveBeenCalled();
  });
  it("handles a PNG in a view of a larger buffer", () => {
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:slice");
    const bytes = new Uint8Array(100); bytes.set(png(12, 20), 8);
    expect(previewImageFromBytes(bytes.subarray(8, 32)).retainedBytes).toBe(984);
    expect((create.mock.calls[0][0] as Blob).size).toBe(24);
  });
  it("revokes owned blob URLs without touching ordinary file or data URLs", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    releasePreviewImage("blob:preview"); releasePreviewImage("data:image/png;base64,abc"); releasePreviewImage("");
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:preview");
  });
});
