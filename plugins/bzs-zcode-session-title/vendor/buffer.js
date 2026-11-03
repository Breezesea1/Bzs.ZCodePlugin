export class VSBuffer {
    buffer;
    byteLength;
    constructor(buffer){
        this.buffer = buffer;
        this.byteLength = buffer.byteLength;
    }
    static alloc(byteLength) {
        return new VSBuffer(new Uint8Array(byteLength));
    }
    static wrap(buffer) {
        return new VSBuffer(buffer);
    }
    static fromString(str) {
        const encoder = new TextEncoder();
        return new VSBuffer(encoder.encode(str));
    }
    static concat(buffers, totalLength) {
        const len = totalLength ?? buffers.reduce((sum, b)=>sum + b.byteLength, 0);
        const result = VSBuffer.alloc(len);
        let offset = 0;
        for (const buf of buffers){
            result.set(buf, offset);
            offset += buf.byteLength;
        }
        return result;
    }
    toString() {
        const decoder = new TextDecoder();
        return decoder.decode(this.buffer);
    }
    slice(start, end) {
        return new VSBuffer(this.buffer.slice(start, end));
    }
    set(source, offset = 0) {
        const raw = source instanceof VSBuffer ? source.buffer : source;
        this.buffer.set(raw, offset);
    }
    readUInt8(offset) {
        return this.buffer[offset];
    }
    writeUInt8(value, offset) {
        this.buffer[offset] = value;
    }
    readUInt32BE(offset) {
        return (this.buffer[offset] << 24 | this.buffer[offset + 1] << 16 | this.buffer[offset + 2] << 8 | this.buffer[offset + 3]) >>> 0;
    }
    writeUInt32BE(value, offset) {
        this.buffer[offset] = value >>> 24 & 0xff;
        this.buffer[offset + 1] = value >>> 16 & 0xff;
        this.buffer[offset + 2] = value >>> 8 & 0xff;
        this.buffer[offset + 3] = value & 0xff;
    }
}
