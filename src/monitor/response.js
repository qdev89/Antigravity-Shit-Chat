/**
 * Response Monitor — tracks agent activity phases and emits events.
 * Uses text length changes as the primary signal (most reliable).
 * 
 * Phase detection:
 *   IDLE → text stable for 16s+
 *   STREAMING → text is actively growing OR stop button visible
 *   COMPLETE → text was growing but stopped (stable for 10s)
 */
import { EventEmitter } from 'events';

export const PHASE = {
    IDLE: 'idle',
    STREAMING: 'streaming',
    COMPLETE: 'complete',
};

export class ResponseMonitor extends EventEmitter {
    constructor(cdpManager, opts = {}) {
        super();
        this.cdp = cdpManager;
        this.pollInterval = opts.pollInterval || 2000;
        this._timer = null;

        // Per-cascade state
        this._state = new Map();
    }

    start() {
        this._timer = setInterval(() => this._poll(), this.pollInterval);
        console.log(`👁️  Response monitor started (${this.pollInterval}ms interval)`);
    }

    stop() {
        if (this._timer) clearInterval(this._timer);
    }

    _getState(id) {
        if (!this._state.has(id)) {
            this._state.set(id, {
                phase: PHASE.IDLE,
                lastTextLen: -1, // -1 = uninitialized (prevents false initial trigger)
                stableCount: 0,
                lastText: '',
                initialized: false,
                completeFired: false // prevent duplicate complete notifications
            });
        }
        return this._state.get(id);
    }

    getPhase(cascadeId) {
        return this._getState(cascadeId).phase;
    }

    async _poll() {
        for (const [id, cascade] of this.cdp.cascades) {
            try {
                const response = await this.cdp.extractResponseText(cascade.cdp);
                if (!response) continue;

                const state = this._getState(id);
                const textLen = response.textLength || 0;

                // First poll: initialize baseline without triggering any phase change
                if (!state.initialized) {
                    state.lastTextLen = textLen;
                    state.lastText = response.text;
                    state.initialized = true;
                    continue;
                }

                const prevPhase = state.phase;
                const textGrew = textLen > state.lastTextLen + 10; // ignore tiny fluctuations

                let newPhase;

                if (response.isStreaming) {
                    // Stop button visible → definitely streaming
                    newPhase = PHASE.STREAMING;
                    state.stableCount = 0;
                    state.completeFired = false; // reset for new streaming session
                } else if (textGrew) {
                    // Text is growing → streaming
                    newPhase = PHASE.STREAMING;
                    state.stableCount = 0;
                    state.completeFired = false;
                } else {
                    // Text not growing
                    state.stableCount++;

                    if (prevPhase === PHASE.STREAMING) {
                        // Was streaming, now stable → complete after 7 polls (14s)
                        newPhase = state.stableCount >= 7 ? PHASE.COMPLETE : PHASE.STREAMING;
                    } else if (prevPhase === PHASE.COMPLETE) {
                        // Was complete, still stable → back to idle after 4 more polls
                        newPhase = state.stableCount >= 11 ? PHASE.IDLE : PHASE.COMPLETE;
                    } else {
                        newPhase = PHASE.IDLE;
                    }
                }

                // Emit phase transitions
                if (newPhase !== prevPhase) {
                    console.log(`👁️  ${prevPhase} → ${newPhase} [${cascade.metadata.chatTitle?.substring(0, 30)}]`);

                    state.phase = newPhase;
                    this.emit('phase', {
                        cascadeId: id,
                        cascade,
                        phase: newPhase,
                        prevPhase,
                        lastMessage: response.text,
                        messageCount: response.messageCount,
                        fullText: response.fullText
                    });

                    // Only fire complete ONCE per streaming session
                    if (newPhase === PHASE.COMPLETE && !state.completeFired) {
                        state.completeFired = true;
                        this.emit('complete', {
                            cascadeId: id,
                            cascade,
                            message: response.text,
                            messageCount: response.messageCount,
                            fullText: response.fullText
                        });
                    }
                    if (newPhase === PHASE.STREAMING && prevPhase === PHASE.IDLE) {
                        this.emit('started', { cascadeId: id, cascade });
                    }
                    // Reset completeFired when going back to idle (fresh start)
                    if (newPhase === PHASE.IDLE) {
                        state.completeFired = false;
                    }
                }

                state.lastTextLen = textLen;
                state.lastText = response.text;
            } catch { }
        }
    }
}
