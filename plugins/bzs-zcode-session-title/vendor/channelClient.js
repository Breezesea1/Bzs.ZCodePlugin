import { VSBuffer } from "./buffer.js";
import { CancellationToken, Event, Emitter } from "./foundation.js";
import { BufferReader, BufferWriter, deserialize, serialize } from "./serialization.js";
import { RequestType, ResponseType } from "./channels.shared.js";
var State = /*#__PURE__*/ function(State) {
    State[State["Uninitialized"] = 0] = "Uninitialized";
    State[State["Idle"] = 1] = "Idle";
    return State;
}(State || {});
export class ChannelClient {
    protocol;
    state = 0;
    isDisposed = false;
    activeRequests = new Set();
    handlers = new Map();
    pendingRejections = new Map();
    lastRequestId = 0;
    protocolListener;
    _onDidInitialize = new Emitter();
    onDidInitialize = this._onDidInitialize.event;
    constructor(protocol){
        this.protocol = protocol;
        this.protocolListener = this.protocol.onMessage((msg)=>this.onBuffer(msg));
    }
    getChannel(channelName) {
        return {
            call: (command, arg, cancellationToken)=>{
                if (this.isDisposed) {
                    return Promise.reject(new Error("ChannelClient is disposed"));
                }
                return this.requestPromise(channelName, command, arg, cancellationToken);
            },
            listen: (event, arg)=>{
                if (this.isDisposed) {
                    return Event.None;
                }
                return this.requestEvent(channelName, event, arg);
            }
        };
    }
    requestPromise(channelName, name, arg, cancellationToken = CancellationToken.None) {
        const id = this.lastRequestId++;
        if (cancellationToken.isCancellationRequested) {
            return Promise.reject(new Error("Cancelled"));
        }
        let disposable;
        const result = new Promise((resolve, reject)=>{
            this.pendingRejections.set(id, reject);
            const doRequest = ()=>{
                if (this.isDisposed || !this.pendingRejections.has(id)) {
                    return;
                }
                const handler = (response)=>{
                    switch(response.type){
                        case ResponseType.PromiseSuccess:
                            this.handlers.delete(id);
                            this.pendingRejections.delete(id);
                            resolve(response.data);
                            return;
                        case ResponseType.PromiseError:
                            {
                                this.handlers.delete(id);
                                this.pendingRejections.delete(id);
                                const error = new Error(response.data.message);
                                error.name = response.data.name;
                                if (response.data.stack) {
                                    error.stack = response.data.stack.join("\n");
                                }
                                const passthroughKeys = [
                                    "code",
                                    "kind",
                                    "status",
                                    "retryAfterMs",
                                    "data",
                                    "detail",
                                    "details",
                                    "taskId",
                                    "traceId"
                                ];
                                for (const key of passthroughKeys){
                                    const value = response.data[key];
                                    if (value !== undefined) {
                                        error[key] = value;
                                    }
                                }
                                reject(error);
                                return;
                            }
                        case ResponseType.PromiseErrorObj:
                            this.handlers.delete(id);
                            this.pendingRejections.delete(id);
                            reject(response.data);
                            return;
                    }
                };
                this.handlers.set(id, handler);
                this.sendRequest(RequestType.Promise, id, channelName, name, arg);
            };
            if (this.state === 1) {
                doRequest();
            } else {
                this.whenInitialized().then(doRequest);
            }
            disposable = cancellationToken.onCancellationRequested(()=>{
                if (!this.pendingRejections.has(id)) {
                    return;
                }
                this.sendCancelOrDispose(RequestType.PromiseCancel, id);
                this.handlers.delete(id);
                this.pendingRejections.delete(id);
                reject(new Error("Cancelled"));
            });
            this.activeRequests.add(disposable);
        });
        return result.finally(()=>{
            disposable?.dispose();
            if (disposable) {
                this.activeRequests.delete(disposable);
            }
        });
    }
    requestEvent(channelName, name, arg) {
        const id = this.lastRequestId++;
        const emitter = new Emitter({
            onWillAddFirstListener: ()=>{
                const doRequest = ()=>{
                    this.activeRequests.add(emitter);
                    this.sendRequest(RequestType.EventListen, id, channelName, name, arg);
                };
                if (this.state === 1) {
                    doRequest();
                } else {
                    this.whenInitialized().then(doRequest);
                }
            },
            onDidRemoveLastListener: ()=>{
                this.activeRequests.delete(emitter);
                this.sendCancelOrDispose(RequestType.EventDispose, id);
                this.handlers.delete(id);
            }
        });
        this.handlers.set(id, (response)=>{
            emitter.fire(response.data);
        });
        return emitter.event;
    }
    sendRequest(type, id, channelName, name, arg) {
        const writer = new BufferWriter();
        serialize(writer, [
            type,
            id,
            channelName,
            name
        ]);
        serialize(writer, arg);
        try {
            this.protocol.send(writer.buffer);
        } catch  {}
    }
    sendCancelOrDispose(type, id) {
        const writer = new BufferWriter();
        serialize(writer, [
            type,
            id
        ]);
        serialize(writer, undefined);
        try {
            this.protocol.send(writer.buffer);
        } catch  {}
    }
    onBuffer(message) {
        const reader = new BufferReader(message);
        const header = deserialize(reader);
        const body = deserialize(reader);
        const type = header[0];
        switch(type){
            case ResponseType.Initialize:
                this.onResponse({
                    type: ResponseType.Initialize
                });
                return;
            case ResponseType.PromiseSuccess:
            case ResponseType.PromiseError:
            case ResponseType.EventFire:
            case ResponseType.PromiseErrorObj:
                this.onResponse({
                    type,
                    id: header[1],
                    data: body
                });
                return;
        }
    }
    onResponse(response) {
        if (response.type === ResponseType.Initialize) {
            this.state = 1;
            this._onDidInitialize.fire();
            return;
        }
        this.handlers.get(response.id)?.(response);
    }
    whenInitialized() {
        if (this.state === 1) {
            return Promise.resolve();
        }
        return Event.toPromise(this.onDidInitialize);
    }
    dispose(reason) {
        if (this.isDisposed) {
            return;
        }
        this.isDisposed = true;
        this.protocolListener?.dispose();
        this.protocolListener = null;
        const rejection = reason ?? new Error("ChannelClient disposed");
        if (!reason) {
            rejection.name = "ConnectionClosed";
        }
        for (const [id, reject] of this.pendingRejections){
            this.pendingRejections.delete(id);
            this.handlers.delete(id);
            reject(rejection);
        }
        for (const disposable of this.activeRequests){
            disposable.dispose();
        }
        this.activeRequests.clear();
        this.pendingRejections.clear();
        this._onDidInitialize.dispose();
    }
}
