// src/tools/browser_tool.js — Headless Playwright browser with safety controls
import { createLogger } from '../utils/logger.js';
import { audit } from '../memory/audit-log.js';
import { getConfig } from '../utils/config.js';

const log = createLogger('browser_tool');

let browser = null;

/**
 * Lazily initialize the Playwright browser instance.
 */
async function getBrowser() {
    if (browser) return browser;

    try {
        // Dynamic import so the module doesn't fail if Playwright isn't installed
        const { chromium } = await import('playwright');
        const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined;

        browser = await chromium.launch({
            headless: getConfig('tools.browser.headless', true),
            executablePath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
            ],
        });

        log.info('Playwright browser launched');
        return browser;
    } catch (err) {
        log.error({ err }, 'Failed to launch Playwright browser');
        throw new Error(`Browser launch failed: ${err.message}`);
    }
}

/**
 * Check if a URL is allowed based on domain restrictions.
 */
function isDomainAllowed(url) {
    const allowedDomains = getConfig('tools.browser.allowedDomains', []);
    const blockedDomains = getConfig('tools.browser.blockedDomains', []);

    let hostname;
    try {
        hostname = new URL(url).hostname;
    } catch {
        return false;
    }

    // If allowlist is defined and non-empty, URL must be in it
    if (allowedDomains.length > 0) {
        return allowedDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
    }

    // Check blocklist
    if (blockedDomains.length > 0) {
        return !blockedDomains.some((d) => hostname === d || hostname.endsWith(`.${d}`));
    }

    return true;
}

/**
 * Execute a browser action.
 * @param {Object} params
 * @param {string} params.action - "navigate" | "screenshot" | "extract_text" | "click" | "fill"
 * @param {string} params.url - Target URL (for navigate/screenshot/extract_text)
 * @param {string} [params.selector] - CSS selector (for click/fill/extract_text)
 * @param {string} [params.value] - Value for fill operations
 * @param {Object} context
 * @returns {Promise<Object>}
 */
export async function executeBrowserTool(params, context) {
    const { action, url, selector, value } = params;
    const { userId, chatId } = context;
    const timeoutMs = getConfig('tools.browser.timeoutMs', 15000);

    // Domain validation for URL-based actions
    if (url && !isDomainAllowed(url)) {
        const msg = `Domain not allowed: ${url}`;
        audit({ action: 'browser_tool', tool: 'browser', userId, chatId, params: { action, url }, status: 'blocked', error: msg });
        return { success: false, error: msg };
    }

    let page = null;
    const consoleErrors = [];

    try {
        const browserInstance = await getBrowser();
        const browserContext = await browserInstance.newContext({
            userAgent: 'AatmanGateway/1.0 (Autonomous Agent)',
        });
        page = await browserContext.newPage();

        // Capture console errors
        page.on('console', (msg) => {
            if (msg.type() === 'error') {
                consoleErrors.push(msg.text());
            }
        });

        let result;

        switch (action) {
            case 'navigate': {
                const response = await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
                result = {
                    status: response?.status(),
                    url: page.url(),
                    title: await page.title(),
                    consoleErrors,
                };
                break;
            }

            case 'screenshot': {
                if (url) {
                    await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
                }
                const buffer = await page.screenshot({ type: 'png', fullPage: false });
                result = {
                    screenshotBase64: buffer.toString('base64'),
                    title: await page.title(),
                    consoleErrors,
                };
                break;
            }

            case 'extract_text': {
                if (url) {
                    await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
                }
                const textContent = selector
                    ? await page.locator(selector).allTextContents()
                    : [await page.innerText('body')];
                result = {
                    text: textContent.join('\n').slice(0, 50000), // Cap at 50K chars
                    title: await page.title(),
                    consoleErrors,
                };
                break;
            }

            case 'click': {
                if (url) {
                    await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
                }
                if (!selector) throw new Error('Selector required for click action');
                await page.locator(selector).click({ timeout: timeoutMs });
                result = {
                    clicked: selector,
                    url: page.url(),
                    consoleErrors,
                };
                break;
            }

            case 'fill': {
                if (url) {
                    await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
                }
                if (!selector) throw new Error('Selector required for fill action');
                if (value === undefined) throw new Error('Value required for fill action');
                await page.locator(selector).fill(value, { timeout: timeoutMs });
                result = {
                    filled: selector,
                    value,
                    consoleErrors,
                };
                break;
            }

            default:
                throw new Error(`Unknown browser_tool action: ${action}`);
        }

        audit({ action: 'browser_tool', tool: 'browser', userId, chatId, params: { action, url, selector }, status: 'success' });
        log.info({ action, url }, 'browser_tool executed');
        return { success: true, ...result };
    } catch (err) {
        audit({ action: 'browser_tool', tool: 'browser', userId, chatId, params: { action, url }, status: 'error', error: err.message });
        log.error({ err, action, url }, 'browser_tool error');
        return { success: false, error: err.message, consoleErrors };
    } finally {
        if (page) {
            try { await page.context().close(); } catch { /* ignore close errors */ }
        }
    }
}

/**
 * Close the browser instance.
 */
export async function closeBrowser() {
    if (browser) {
        await browser.close();
        browser = null;
        log.info('Browser closed');
    }
}

/** Tool schema for LLM context */
export const browserToolSchema = {
    name: 'browser_tool',
    description: 'Control a headless browser for web interaction. Supports: navigate, screenshot, extract_text, click, fill. Has domain restrictions and timeout enforcement.',
    parameters: {
        action: { type: 'string', enum: ['navigate', 'screenshot', 'extract_text', 'click', 'fill'], required: true },
        url: { type: 'string', description: 'Target URL' },
        selector: { type: 'string', description: 'CSS selector for element interaction' },
        value: { type: 'string', description: 'Value for fill operations' },
    },
};
