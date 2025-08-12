import { BareHeaders, TransferrableResponse } from "./baretypes";
import { nativeLocalStorage, nativePostMessage, nativeServiceWorker, nativeBroadcastChannel } from "./snapshot";
import { initializeBroadcastWorker } from "./broadcastWorker";

// Check if SharedWorker is available for fallback
const hasSharedWorker = typeof SharedWorker !== 'undefined';

type SWClient = { postMessage: typeof MessagePort.prototype.postMessage };

export type WorkerMessage = {
	type: "fetch" | "websocket" | "set" | "get" | "ping",
	fetch?: {
		remote: string,
		method: string,
		headers: BareHeaders,
		body: ReadableStream | ArrayBuffer | undefined,
	}
	websocket?: {
		url: string,
		protocols: string[],
		requestHeaders: BareHeaders,
		channel: MessagePort,
	},
	client?: {
		function: string,
		args: any[],
	},
};

export type WorkerRequest = {
	message: WorkerMessage,
	port: MessagePort,
}

export type WorkerResponse = {
	type: "fetch" | "websocket" | "set" | "get" | "pong" | "error",
	fetch?: TransferrableResponse,
	name?: string,
	error?: Error,
}

export type BroadcastMessage = {
	type: "refreshPort",
}

async function searchForWorker(): Promise<boolean> {
	// Check if there's an active worker via BroadcastChannel
	const workerChannel = new nativeBroadcastChannel("bare-mux-worker");
	const promise: Promise<boolean> = new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			workerChannel.close();
			reject(new Error("timeout"));
		}, 500); // Reduced timeout for faster detection
		
		workerChannel.addEventListener("message", (event) => {
			if (event.data.type === "worker-pong" || event.data.type === "worker-elected") {
				clearTimeout(timeout);
				workerChannel.close();
				resolve(true);
			}
		});
		
		// Send ping and also trigger election in case no worker is active
		workerChannel.postMessage({ type: "worker-ping" });
		setTimeout(() => {
			workerChannel.postMessage({ type: "elect-worker", workerId: "client-ping" });
		}, 50);
	});

	try {
		return await promise;
	} catch (err) {
		console.warn("bare-mux: failed to find active worker within 500ms, will start new worker");
		return false;
	}
}

let workerInitialized = false;

async function ensureWorkerExists(): Promise<void> {
	if (workerInitialized) return;
	
	// Initialize the broadcast worker
	initializeBroadcastWorker();
	workerInitialized = true;
	
	// Give the worker a moment to initialize
	await new Promise(resolve => setTimeout(resolve, 100));
}

function testWorker(): Promise<void> {
	const responseChannelName = `bare-mux-response-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
	const responseChannel = new nativeBroadcastChannel(responseChannelName);
	const workerChannel = new nativeBroadcastChannel("bare-mux-worker");
	
	const pingPromise: Promise<void> = new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			responseChannel.close();
			workerChannel.close();
			reject(new Error("timeout"));
		}, 1500);
		
		responseChannel.addEventListener("message", (event) => {
			if (event.data.type === "pong") {
				clearTimeout(timeout);
				responseChannel.close();
				workerChannel.close();
				resolve();
			}
		});
		
		workerChannel.postMessage({
			type: "worker-request",
			data: { message: { type: "ping" } },
			responseChannel: responseChannelName
		});
	});
	
	return pingPromise;
}

async function createWorkerConnection(path?: string, registerHandlers?: boolean): Promise<boolean> {
	// Check if worker already exists
	const hasWorker = await searchForWorker();
	if (hasWorker) {
		return true;
	}
	
	// Ensure worker is initialized
	await ensureWorkerExists();
	
	if (registerHandlers && nativeServiceWorker) {
		nativeServiceWorker.addEventListener("message", (event: MessageEvent) => {
			if (event.data.type === "getPort" && event.data.port) {
				console.debug("bare-mux: received request for connection from sw");
				// For service worker requests, we just confirm the worker exists
				nativePostMessage.call(event.data.port, { connected: true });
			}
		});
	}
	
	return true;
}

let browserSupportsTransferringStreamsCache: boolean | null = null;
export function browserSupportsTransferringStreams(): boolean {
	if (browserSupportsTransferringStreamsCache === null) {
		const chan = new MessageChannel();
		const stream = new ReadableStream();
		let res: boolean;
		try {
			nativePostMessage.call(chan.port1, stream, [stream]);
			res = true;
		} catch (err) {
			res = false;
		}
		browserSupportsTransferringStreamsCache = res;
		return res;
	} else {
		return browserSupportsTransferringStreamsCache;
	}
}

export class WorkerConnection {
	channel: BroadcastChannel;
	workerReady: Promise<boolean>;
	workerPath: string;
	sharedWorkerPort?: MessagePort | Promise<MessagePort>;
	useSharedWorker: boolean = false;

	constructor(worker?: string | Promise<MessagePort> | MessagePort) {
		this.channel = new BroadcastChannel("bare-mux");
		if (worker instanceof MessagePort || worker instanceof Promise) {
			// For backward compatibility, treat MessagePort as ready
			this.sharedWorkerPort = worker;
			this.useSharedWorker = true;
			this.workerReady = Promise.resolve(true);
		} else {
			this.workerReady = this.createChannel(worker, true);
		}
	}

	async createChannel(workerPath?: string, inInit?: boolean): Promise<boolean> {
		// @ts-expect-error
		if (self.clients) {
			// running in a ServiceWorker
			// ensure worker exists and register for refreshPort
			const hasWorker = await createWorkerConnection(workerPath, inInit);
			this.channel.onmessage = (event: MessageEvent) => {
				if (event.data.type === "refreshPort") {
					// Refresh worker connection
					this.workerReady = createWorkerConnection(workerPath, false);
				}
			}
			return hasWorker;
		} else if (workerPath && nativeBroadcastChannel) {
			// running in a window, was passed a workerPath
			// create the BroadcastChannel worker and help other bare-mux clients get the workerPath

			if (!workerPath.startsWith("/") && !workerPath.includes("://")) throw new Error("Invalid URL. Must be absolute or start at the root.");
			const connected = await createWorkerConnection(workerPath, inInit);
			console.debug("bare-mux: setting localStorage bare-mux-path to", workerPath);
			nativeLocalStorage["bare-mux-path"] = workerPath;
			return connected;
		} else if (nativeBroadcastChannel) {
			// running in a window, was not passed a workerPath
			// use localStorage for the workerPath
			const path = nativeLocalStorage["bare-mux-path"];
			console.debug("bare-mux: got localStorage bare-mux-path:", path);
			if (!path) throw new Error("Unable to get bare-mux workerPath from localStorage.");
			return await createWorkerConnection(path, inInit);
		} else {
			// BroadcastChannel does not exist
			throw new Error("Unable to get a channel to the BroadcastChannel worker.");
		}
	}

	async sendMessage(message: WorkerMessage, transferable?: Transferable[]): Promise<WorkerResponse> {
		// Check if we should use SharedWorker fallback for operations that need MessagePort transfers
		const needsMessagePortTransfer = message.type === "websocket" || (transferable && transferable.length > 0);
		
		if (needsMessagePortTransfer && hasSharedWorker && !this.useSharedWorker) {
			console.debug("bare-mux: Using SharedWorker fallback for MessagePort transfer operation");
			return await this.sendMessageViaSharedWorker(message, transferable);
		}
		
		if (this.useSharedWorker) {
			return await this.sendMessageViaSharedWorker(message, transferable);
		}

		// Ensure worker is ready
		await this.workerReady;

		try {
			await testWorker();
		} catch {
			console.warn("bare-mux: Failed to get a ping response from the worker within 1.5s. Assuming worker is dead.");
			this.workerReady = this.createChannel();
			return await this.sendMessage(message, transferable);
		}

		// Create unique response channel for this request
		const responseChannelName = `bare-mux-response-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
		const responseChannel = new nativeBroadcastChannel(responseChannelName);
		const workerChannel = new nativeBroadcastChannel("bare-mux-worker");

		const promise: Promise<WorkerResponse> = new Promise((resolve, reject) => {
			const timeout = setTimeout(() => {
				responseChannel.close();
				workerChannel.close();
				reject(new Error("Worker request timeout"));
			}, 10000);
			
			responseChannel.addEventListener("message", (event) => {
				const response = event.data;
				clearTimeout(timeout);
				responseChannel.close();
				workerChannel.close();
				
				if (response.type === "error") {
					reject(response.error);
				} else {
					resolve(response);
				}
			});
		});

		// Send message to worker
		workerChannel.postMessage({
			type: "worker-request",
			data: { message },
			responseChannel: responseChannelName
		});

		return await promise;
	}

	async sendMessageViaSharedWorker(message: WorkerMessage, transferable?: Transferable[]): Promise<WorkerResponse> {
		// Create or get SharedWorker connection for fallback
		if (!this.sharedWorkerPort) {
			// Create SharedWorker fallback
			const workerPath = this.workerPath || nativeLocalStorage["bare-mux-path"];
			if (!workerPath) {
				throw new Error("No SharedWorker path available for fallback");
			}
			const worker = new SharedWorker(workerPath, "bare-mux-worker");
			this.sharedWorkerPort = worker.port;
		}
		
		const port = this.sharedWorkerPort instanceof Promise ? await this.sharedWorkerPort : this.sharedWorkerPort;
		
		// Test the SharedWorker port
		try {
			await this.testSharedWorkerPort(port);
		} catch {
			console.warn("bare-mux: SharedWorker port failed, recreating...");
			const workerPath = this.workerPath || nativeLocalStorage["bare-mux-path"];
			if (!workerPath) {
				throw new Error("No SharedWorker path available for fallback");
			}
			const worker = new SharedWorker(workerPath, "bare-mux-worker");
			this.sharedWorkerPort = worker.port;
			return await this.sendMessageViaSharedWorker(message, transferable);
		}

		const channel = new MessageChannel();
		const toTransfer: Transferable[] = [channel.port2, ...(transferable || [])];

		const promise: Promise<WorkerResponse> = new Promise((resolve, reject) => {
			channel.port1.onmessage = event => {
				const response = event.data;
				if (response.type === "error") {
					reject(response.error);
				} else {
					resolve(response);
				}
			}
		});

		nativePostMessage.call(port, { message: message, port: channel.port2 }, toTransfer);

		return await promise;
	}

	async testSharedWorkerPort(port: MessagePort): Promise<void> {
		const pingChannel = new MessageChannel();
		const pingPromise: Promise<void> = new Promise((resolve, reject) => {
			pingChannel.port1.onmessage = event => {
				if (event.data.type === "pong") {
					resolve();
				}
			};
			setTimeout(reject, 1500);
		});
		nativePostMessage.call(port, { message: { type: "ping" }, port: pingChannel.port2 }, [pingChannel.port2]);
		return pingPromise;
	}
}
