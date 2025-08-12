import { BareTransport } from "./baretypes";
import { BroadcastMessage, WorkerMessage, WorkerRequest, WorkerResponse } from "./connection";
import { handleFetch, handleWebsocket, sendError } from "./workerHandlers";
import { nativeBroadcastChannel } from "./snapshot";

let currentTransport: BareTransport | MessagePort | null = null;
let currentTransportName: string = "";
let isWorkerActive = false;
let workerId: string = "";

// Generate unique worker ID
workerId = `worker-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

const channel = new nativeBroadcastChannel("bare-mux");
const workerChannel = new nativeBroadcastChannel("bare-mux-worker");

function noClients(): Error {
	// @ts-expect-error mdn error constructor: new Error(message, options)
	return new Error("there are no bare clients", {
		cause: "No BareTransport was set. Try creating a BareMuxConnection and calling `setTransport()` or `setManualTransport()` on it before using BareClient."
	});
}

function handleRemoteClient(message: WorkerMessage, responseChannel: string) {
	const remote = currentTransport as MessagePort;
	// For remote clients, we need to handle the response differently
	const responseHandler = (event: MessageEvent) => {
		const response = new nativeBroadcastChannel(responseChannel);
		response.postMessage(event.data);
		response.close();
	};
	
	if (remote.onmessage) {
		const originalHandler = remote.onmessage;
		remote.onmessage = (event) => {
			originalHandler.call(remote, event);
			handleRemoteClient(message, responseChannel);
		};
	} else {
		remote.onmessage = responseHandler;
	}
	
	remote.postMessage({ message });
}

async function handleWorkerMessage(event: MessageEvent) {
	const { type, data, responseChannel, workerId: requestWorkerId } = event.data;
	
	// Only handle messages if we're the active worker or if it's a worker election message
	if (!isWorkerActive && type !== "elect-worker" && type !== "worker-ping") {
		return;
	}
	
	if (type === "elect-worker") {
		// Simple leader election - first to respond becomes the worker
		if (!isWorkerActive && requestWorkerId !== workerId) {
			isWorkerActive = true;
			workerChannel.postMessage({
				type: "worker-elected",
				workerId: workerId
			});
			console.debug("bare-mux: elected as active worker", workerId);
		} else if (isWorkerActive) {
			// Already active, announce it
			workerChannel.postMessage({
				type: "worker-elected",
				workerId: workerId
			});
			console.debug("bare-mux: already active worker", workerId);
		}
		return;
	}
	
	if (type === "worker-ping") {
		if (isWorkerActive) {
			console.debug("bare-mux: responding to worker ping", workerId);
			workerChannel.postMessage({
				type: "worker-pong",
				workerId: workerId
			});
		} else {
			console.debug("bare-mux: ignoring worker ping (not active)", workerId);
		}
		return;
	}
	
	if (type === "worker-request") {
		const message: WorkerMessage = data.message;
		const response = new nativeBroadcastChannel(responseChannel);
		
		console.debug("bare-mux: handling worker request", message.type, "from worker", workerId);
		
		try {
			if (message.type === "ping") {
				console.debug("bare-mux: responding to ping request");
				response.postMessage({ type: "pong" });
			} else if (message.type === "set") {
				try {
					const AsyncFunction = (async function() { }).constructor;

					if (message.client.function === "bare-mux-remote") {
						currentTransport = message.client.args[0] as MessagePort;
						currentTransportName = `bare-mux-remote (${message.client.args[1]})`;
					} else {
						try {
							// @ts-expect-error
							const func = new AsyncFunction(message.client.function);
							const [newTransport, name] = await func();
							currentTransport = new newTransport(...message.client.args);
							currentTransportName = name;
						} catch (err) {
							err.cause = "The BareTransport provided was invalid. Common causes of this are a default export that is not a class that implements BareTransport if you are using `setTransport()`";
							throw err;
						}
					}
					console.log("set transport to ", currentTransport, currentTransportName);

					response.postMessage({ type: "set" });
				} catch (err) {
					response.postMessage({ type: "error", error: err });
				}
			} else if (message.type === "get") {
				response.postMessage({ type: "get", name: currentTransportName });
			} else if (message.type === "fetch") {
				try {
					if (!currentTransport) throw noClients();
					if (currentTransport instanceof MessagePort) {
						handleRemoteClient(message, responseChannel);
						return;
					}
					if (!currentTransport.ready) await currentTransport.init();

					await handleFetch(message, {
						postMessage: (data: any) => response.postMessage(data)
					} as MessagePort, currentTransport);
				} catch (err) {
					response.postMessage({ type: "error", error: err });
				}
			} else if (message.type === "websocket") {
				try {
					if (!currentTransport) throw noClients();
					if (currentTransport instanceof MessagePort) {
						handleRemoteClient(message, responseChannel);
						return;
					}
					if (!currentTransport.ready) await currentTransport.init();

					// For WebSocket connections, we need to handle the MessagePort properly
					// The message.websocket.channel is already a real MessagePort from the client
					// We just need to pass it through correctly
					await handleWebsocket(message, {
						postMessage: (data: any) => response.postMessage(data)
					} as MessagePort, currentTransport);
				} catch (err) {
					response.postMessage({ type: "error", error: err });
				}
			}
		} finally {
			// Close the response channel after a delay to ensure message is sent
			setTimeout(() => response.close(), 100);
		}
	}
}

let workerInitialized = false;

export function initializeBroadcastWorker() {
	if (workerInitialized) return; // Already initialized
	workerInitialized = true;
	
	// @ts-expect-error this gets filled in
	console.debug(`bare-mux: initializing broadcast worker v${self.BARE_MUX_VERSION || 'dev'} (build ${self.BARE_MUX_COMMITHASH || 'dev'})`);
	
	// Listen for worker messages immediately
	workerChannel.addEventListener("message", handleWorkerMessage);

	// Become active immediately if this is the first worker
	if (!isWorkerActive) {
		isWorkerActive = true;
		console.debug("bare-mux: became active worker (first initialization)", workerId);
	}

	// Announce this worker is available
	setTimeout(() => {
		workerChannel.postMessage({
			type: "elect-worker",
			workerId: workerId
		});
	}, 10);
}

export { workerId, isWorkerActive };
