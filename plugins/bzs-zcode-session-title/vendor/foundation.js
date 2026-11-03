export function toDisposable(fn) {
    return {
        dispose: once(fn)
    };
}
function once(fn) {
    let called = false;
    return ()=>{
        if (!called) {
            called = true;
            fn();
        }
    };
}
export class DisposableStore {
    items = new Set();
    isDisposed = false;
    add(item) {
        if (this.isDisposed) {
            console.warn("Adding to a disposed DisposableStore");
            item.dispose();
            return item;
        }
        this.items.add(item);
        return item;
    }
    dispose() {
        if (this.isDisposed) {
            return;
        }
        this.isDisposed = true;
        for (const item of this.items){
            item.dispose();
        }
        this.items.clear();
    }
}
(function(Event) {
    Event.None = ()=>({
            dispose () {}
        });
    function once(event) {
        return (listener)=>{
            let fired = false;
            const disposable = event((e)=>{
                if (!fired) {
                    fired = true;
                    disposable.dispose();
                    listener(e);
                }
            });
            return disposable;
        };
    }
    Event.once = once;
    function toPromise(event) {
        return new Promise((resolve)=>once(event)(resolve));
    }
    Event.toPromise = toPromise;
    function filter(event, fn) {
        return (listener)=>event((e)=>{
                if (fn(e)) {
                    listener(e);
                }
            });
    }
    Event.filter = filter;
    function map(event, fn) {
        return (listener)=>event((e)=>listener(fn(e)));
    }
    Event.map = map;
})(Event || (Event = {}));
export class Emitter {
    listeners = new Set();
    disposed = false;
    options;
    constructor(options){
        this.options = options;
    }
    get event() {
        return (listener)=>{
            if (this.disposed) {
                return {
                    dispose () {}
                };
            }
            const isFirst = this.listeners.size === 0;
            this.listeners.add(listener);
            if (isFirst) {
                this.options?.onWillAddFirstListener?.();
            }
            return toDisposable(()=>{
                this.listeners.delete(listener);
                if (this.listeners.size === 0) {
                    this.options?.onDidRemoveLastListener?.();
                }
            });
        };
    }
    fire(event) {
        if (this.disposed) {
            return;
        }
        for (const listener of [
            ...this.listeners
        ]){
            listener(event);
        }
    }
    dispose() {
        this.disposed = true;
        this.listeners.clear();
    }
}
export class Relay {
    emitter = new Emitter();
    inputDisposable = {
        dispose () {}
    };
    event = this.emitter.event;
    set input(event) {
        this.inputDisposable.dispose();
        this.inputDisposable = event((e)=>this.emitter.fire(e));
    }
    dispose() {
        this.inputDisposable.dispose();
        this.emitter.dispose();
    }
}
export class EventMultiplexer {
    emitter = new Emitter();
    disposables = [];
    event = this.emitter.event;
    add(event) {
        const d = event((e)=>this.emitter.fire(e));
        this.disposables.push(d);
        return d;
    }
    dispose() {
        for (const d of this.disposables){
            d.dispose();
        }
        this.emitter.dispose();
    }
}
(function(CancellationToken) {
    CancellationToken.None = {
        isCancellationRequested: false,
        onCancellationRequested: Event.None
    };
})(CancellationToken || (CancellationToken = {}));
export class CancellationTokenSource {
    _token;
    emitter = new Emitter();
    _isCancelled = false;
    get token() {
        if (!this._token) {
            this._token = {
                isCancellationRequested: false,
                onCancellationRequested: this.emitter.event
            };
        }
        return this._token;
    }
    cancel() {
        if (!this._isCancelled) {
            this._isCancelled = true;
            this.emitter.fire();
        }
    }
    dispose() {
        this.emitter.dispose();
    }
}
export var Event, CancellationToken;
