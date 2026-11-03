import { VSBuffer } from "./buffer.js";
export class BufferReader {
    buffer;
    pos = 0;
    constructor(buffer){
        this.buffer = buffer;
    }
    read(bytes) {
        const result = this.buffer.slice(this.pos, this.pos + bytes);
        this.pos += result.byteLength;
        return result;
    }
}
export class BufferWriter {
    buffers = [];
    get buffer() {
        return VSBuffer.concat(this.buffers);
    }
    write(buffer) {
        this.buffers.push(buffer);
    }
}
function readIntVQL(reader) {
    let value = 0;
    for(let n = 0;; n += 7){
        const next = reader.read(1);
        value |= (next.buffer[0] & 0b01111111) << n;
        if (!(next.buffer[0] & 0b10000000)) {
            return value;
        }
    }
}
const vqlZero = createOneByteBuffer(0);
function writeInt32VQL(writer, value) {
    if (value === 0) {
        writer.write(vqlZero);
        return;
    }
    let len = 0;
    for(let v = value; v !== 0; v = v >>> 7){
        len++;
    }
    const scratch = VSBuffer.alloc(len);
    for(let i = 0; value !== 0; i++){
        scratch.buffer[i] = value & 0b01111111;
        value = value >>> 7;
        if (value > 0) {
            scratch.buffer[i] |= 0b10000000;
        }
    }
    writer.write(scratch);
}
var DataType = /*#__PURE__*/ function(DataType) {
    DataType[DataType["Undefined"] = 0] = "Undefined";
    DataType[DataType["String"] = 1] = "String";
    DataType[DataType["Buffer"] = 2] = "Buffer";
    DataType[DataType["VSBuffer"] = 3] = "VSBuffer";
    DataType[DataType["Array"] = 4] = "Array";
    DataType[DataType["Object"] = 5] = "Object";
    DataType[DataType["Int"] = 6] = "Int";
    return DataType;
}(DataType || {});
function createOneByteBuffer(value) {
    const result = VSBuffer.alloc(1);
    result.writeUInt8(value, 0);
    return result;
}
const BufferPresets = {
    Undefined: createOneByteBuffer(0),
    String: createOneByteBuffer(1),
    Buffer: createOneByteBuffer(2),
    VSBuffer: createOneByteBuffer(3),
    Array: createOneByteBuffer(4),
    Object: createOneByteBuffer(5),
    Int: createOneByteBuffer(6)
};
const RPC_NESTED_UINT8_ARRAY_MARKER = "__zcode_rpc_nested_uint8array_v1";
const RPC_NESTED_UINT8_ARRAY_BASE64_KEY = "base64";
export function serialize(writer, data) {
    if (typeof data === "undefined") {
        writer.write(BufferPresets.Undefined);
    } else if (typeof data === "string") {
        const buffer = VSBuffer.fromString(data);
        writer.write(BufferPresets.String);
        writeInt32VQL(writer, buffer.byteLength);
        writer.write(buffer);
    } else if (data instanceof VSBuffer) {
        writer.write(BufferPresets.VSBuffer);
        writeInt32VQL(writer, data.byteLength);
        writer.write(data);
    } else if (data instanceof Uint8Array) {
        const buffer = VSBuffer.wrap(data);
        writer.write(BufferPresets.Buffer);
        writeInt32VQL(writer, buffer.byteLength);
        writer.write(buffer);
    } else if (Array.isArray(data)) {
        writer.write(BufferPresets.Array);
        writeInt32VQL(writer, data.length);
        for (const el of data){
            serialize(writer, el);
        }
    } else if (typeof data === "number" && (data | 0) === data) {
        writer.write(BufferPresets.Int);
        writeInt32VQL(writer, data);
    } else {
        const buffer = VSBuffer.fromString(JSON.stringify(data, encodeRpcJsonValue));
        writer.write(BufferPresets.Object);
        writeInt32VQL(writer, buffer.byteLength);
        writer.write(buffer);
    }
}
export function deserialize(reader) {
    const type = reader.read(1).readUInt8(0);
    switch(type){
        case 0:
            return undefined;
        case 1:
            return reader.read(readIntVQL(reader)).toString();
        case 2:
            return reader.read(readIntVQL(reader)).buffer;
        case 3:
            return reader.read(readIntVQL(reader));
        case 4:
            {
                const length = readIntVQL(reader);
                const result = [];
                for(let i = 0; i < length; i++){
                    result.push(deserialize(reader));
                }
                return result;
            }
        case 5:
            return JSON.parse(reader.read(readIntVQL(reader)).toString(), decodeRpcJsonValue);
        case 6:
            return readIntVQL(reader);
    }
}
function encodeRpcJsonValue(_key, value) {
    if (value instanceof Uint8Array) {
        return {
            [RPC_NESTED_UINT8_ARRAY_MARKER]: true,
            [RPC_NESTED_UINT8_ARRAY_BASE64_KEY]: bytesToBase64(value)
        };
    }
    return value;
}
function decodeRpcJsonValue(_key, value) {
    if (!isRpcEncodedUint8Array(value)) {
        return value;
    }
    return base64ToBytes(value[RPC_NESTED_UINT8_ARRAY_BASE64_KEY]);
}
function isRpcEncodedUint8Array(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const record = value;
    return record[RPC_NESTED_UINT8_ARRAY_MARKER] === true && typeof record[RPC_NESTED_UINT8_ARRAY_BASE64_KEY] === "string" && Object.keys(record).length === 2;
}
function bytesToBase64(bytes) {
    const bufferCtor = globalThis.Buffer;
    if (bufferCtor) {
        return bufferCtor.from(bytes).toString("base64");
    }
    let binary = "";
    const chunkSize = 0x8000;
    for(let offset = 0; offset < bytes.length; offset += chunkSize){
        const chunk = bytes.subarray(offset, offset + chunkSize);
        binary += String.fromCharCode(...chunk);
    }
    return globalThis.btoa(binary);
}
function base64ToBytes(base64) {
    const bufferCtor = globalThis.Buffer;
    if (bufferCtor) {
        return new Uint8Array(bufferCtor.from(base64, "base64"));
    }
    const binary = globalThis.atob(base64);
    const bytes = new Uint8Array(binary.length);
    for(let index = 0; index < binary.length; index += 1){
        bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
}
