import { Actor } from 'apify';
import { launchPuppeteer, log } from 'crawlee';

const randomDelay = (min, max) =>
    new Promise(res => setTimeout(res, Math.floor(Math.random() * (max - min + 1)) + min));

await Actor.init();

const input = await Actor.getInput();
const {
    li_at,
    jsessionid = '',
    profileUrls = [],
    message = '',
    maxRequests = 20,
    delayBetweenMin = 90000,
    delayBetweenMax = 150000,
} = input;

if (!li_at) throw new Error('li_at cookie is required!');
if (!profileUrls || profileUrls.length === 0) throw new Error('No profile URLs provided!');

log.info(`Starting LinkedIn Connection Request Actor`);
log.info(`Profiles to process: ${profileUrls.length}`);

const profilesToProcess = profileUrls.slice(0, maxRequests);

const browser = await launchPuppeteer({
    launchOptions: {
        headless: true,
        args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-blink-features=AutomationControlled','--window-size=1366,768'],
    },
    useChrome: true,
    stealth: true,
});

const results = [];

try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const cookiesToSet = [{ name: 'li_at', value: li_at, domain: '.linkedin.com', path: '/' }];
    if (jsessionid) cookiesToSet.push({ name: 'JSESSIONID', value: jsessionid, domain: '.linkedin.com', path: '/' });
    await page.setCookie(...cookiesToSet);

    log.info('Verifying login...');
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'networkidle2', timeout: 30000 });

    const isLoggedIn = await page.evaluate(() => {
        return !!document.querySelector('nav.global-nav') || window.location.href.includes('/feed');
    });
    if (!isLoggedIn) throw new Error('Login failed! li_at cookie may be expired.');
    log.info('Successfully logged into LinkedIn!');
    await randomDelay(3000, 5000);

    for (let i = 0; i < profilesToProcess.length; i++) {
        const profileUrl = profilesToProcess[i].trim();
        log.info(`[${i + 1}/${profilesToProcess.length}] Processing: ${profileUrl}`);

        const result = { profileUrl, status: 'pending', message: '', timestamp: new Date().toISOString() };

        try {
            await page.goto(profileUrl, { waitUntil: 'networkidle2', timeout: 30000 });
            await randomDelay(2000, 4000);

            const isConnected = await page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('button'));
                return buttons.some(b => b.textContent.includes('Message') || b.textContent.includes('Connected') || b.textContent.includes('Pending'));
            });

            if (isConnected) {
                log.info(`Already connected or pending for ${profileUrl}`);
                result.status = 'skipped';
                result.message = 'Already connected or pending';
                results.push(result);
                await Actor.pushData(result);
                continue;
            }

            let connectBtn = await page.$('button[aria-label*="Connect"]');
            if (!connectBtn) {
                const moreBtn = await page.$('button[aria-label*="More actions"]');
                if (moreBtn) {
                    await moreBtn.click();
                    await randomDelay(1000, 2000);
                    connectBtn = await page.$('div[aria-label*="Connect"]');
                }
            }
            if (!connectBtn) {
                const handle = await page.evaluateHandle(() => {
                    const buttons = Array.from(document.querySelectorAll('button'));
                    return buttons.find(b => b.textContent.trim() === 'Connect') || null;
                });
                const el = handle.asElement();
                connectBtn = el || null;
            }

            if (!connectBtn) {
                result.status = 'error';
                result.message = 'Connect button not found';
                results.push(result);
                await Actor.pushData(result);
                continue;
            }

            await connectBtn.click();
            await randomDelay(1500, 3000);

            if (message && message.trim()) {
                const addNoteBtn = await page.$('button[aria-label="Add a note"]');
                if (addNoteBtn) {
                    await addNoteBtn.click();
                    await randomDelay(1000, 2000);
                    const textarea = await page.$('textarea[name="message"]') || await page.$('textarea');
                    if (textarea) {
                        await textarea.focus();
                        for (const char of message) {
                            await page.keyboard.type(char, { delay: Math.floor(Math.random() * 60) + 20 });
                        }
                        await randomDelay(500, 1000);
                    }
                }
            }

            const sendBtn = await page.$('button[aria-label="Send now"]') || await page.$('button[aria-label="Send invitation"]');
            if (sendBtn) {
                await sendBtn.click();
                await randomDelay(2000, 3000);
                result.status = 'sent';
                result.message = 'Connection request sent successfully';
                log.info(`Connection request sent to ${profileUrl}`);
            } else {
                result.status = 'error';
                result.message = 'Send button not found';
            }

        } catch (err) {
            log.error(`Error for ${profileUrl}: ${err.message}`);
            result.status = 'error';
            result.message = err.message;
            try {
                const screenshot = await page.screenshot({ fullPage: false });
                await Actor.setValue(`error-screenshot-${i}`, screenshot, { contentType: 'image/png' });
            } catch (_) {}
        }

        results.push(result);
        await Actor.pushData(result);

        if (i < profilesToProcess.length - 1) {
            const delay = Math.floor(Math.random() * (delayBetweenMax - delayBetweenMin + 1)) + delayBetweenMin;
            log.info(`Waiting ${Math.round(delay / 1000)}s before next profile...`);
            await randomDelay(delayBetweenMin, delayBetweenMax);
        }
    }

} finally {
    await browser.close();
}

const sent = results.filter(r => r.status === 'sent').length;
const skipped = results.filter(r => r.status === 'skipped').length;
const errors = results.filter(r => r.status === 'error').length;

log.info(`SUMMARY — Sent: ${sent} | Skipped: ${skipped} | Errors: ${errors}`);
await Actor.exit();
