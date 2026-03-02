/**
 * CDP Connection — WebSocket-based Chrome DevTools Protocol client.
 * Handles connection lifecycle, method calls, and execution context tracking.
 */
import WebSocket from 'ws';

export async function connectCDP(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
        ws.on('open', resolve);
        ws.on('error', reject);
    });

    let idCounter = 1;
    const pendingCalls = new Map();

    const call = (method, params) => new Promise((resolve, reject) => {
        const id = idCounter++;
        const timeout = setTimeout(() => {
            pendingCalls.delete(id);
            reject(new Error(`CDP call ${method} timed out`));
        }, 10000);
        pendingCalls.set(id, { resolve, reject, timeout });
        ws.send(JSON.stringify({ id, method, params }));
    });

    const contexts = [];

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);

            // Handle RPC responses
            if (data.id && pendingCalls.has(data.id)) {
                const { resolve, reject, timeout } = pendingCalls.get(data.id);
                clearTimeout(timeout);
                pendingCalls.delete(data.id);
                if (data.error) reject(data.error);
                else resolve(data.result);
            }

            // Track execution contexts
            if (data.method === 'Runtime.executionContextCreated') {
                contexts.push(data.params.context);
            } else if (data.method === 'Runtime.executionContextDestroyed') {
                const idx = contexts.findIndex(c => c.id === data.params.executionContextId);
                if (idx !== -1) contexts.splice(idx, 1);
            }
        } catch (e) { }
    });

    await call('Runtime.enable', {});
    await new Promise(r => setTimeout(r, 500)); // let contexts arrive

    return { ws, call, contexts, rootContextId: null };
}
