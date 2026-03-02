/**
 * DOM Selectors — centralized selector definitions for Antigravity UI elements.
 * Easy to update when Antigravity changes its DOM structure.
 */
export const SELECTORS = {
    // Chat panel identifiers (tried in order)
    CHAT_PANEL: [
        '#conversation',
        '#cascade',
        '.antigravity-agent-side-panel'
    ],

    // Title extraction
    WINDOW_TITLE: '.window-title',

    // Input elements
    EDITOR: '[contenteditable="true"]',
    TEXTAREA: 'textarea',

    // Send button (tried in order)
    SEND_BUTTON: [
        'button[class*="arrow"]',
        'button[aria-label*="Send"]',
        'button[type="submit"]'
    ],

    // Response monitoring
    STOP_BUTTON: [
        'button[aria-label*="Stop"]',
        'button[aria-label*="Cancel"]',
        'button[class*="stop"]'
    ],

    // Approval/confirmation dialogs
    APPROVAL_DIALOG: [
        '[class*="dialog"]',
        '[class*="confirm"]',
        '[class*="approval"]'
    ],

    // Agent status indicators
    THINKING_INDICATOR: [
        '[class*="thinking"]',
        '[class*="loading"]',
        '[class*="spinner"]'
    ],

    // Side panel background
    SIDE_PANEL: '.antigravity-agent-side-panel',

    // Input wrapper to remove from snapshots
    INPUT_WRAPPER: '.relative.w-full'
};
