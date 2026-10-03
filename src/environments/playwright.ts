import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
} from "playwright";

import type { QAAction, QAActionOutcome, SemanticTarget } from "../core/actions";
import type {
  QAElement,
  QAEnvironment,
  QAObservation,
  QADiagnostic,
} from "../core/environment";

export class PlaywrightEnvironment implements QAEnvironment {
  constructor(private readonly options: { headed?: boolean; tracePath?: string } = {}) {}
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;

  private errors: string[] = [];
  private diagnostics: QADiagnostic[] = [];
  private requests = new WeakMap<Request, { id: string; startedAt: string }>();
  private nextRequest = 0;
  private screenshotCapturedAt?: string;
  private lastScreenshotPath?: string;

  async start(): Promise<void> {
    if (this.browser) {
      throw new Error("PlaywrightEnvironment has already been started");
    }

    try {
      this.browser = await chromium.launch({
        headless: !this.options.headed,
      });

      this.context = await this.browser.newContext({ viewport: { width: 1280, height: 720 } });
      if (this.options.tracePath) await this.context.tracing.start({ screenshots: true, snapshots: true });

      this.page = await this.context.newPage();
      this.page.setDefaultTimeout(10_000);

      this.attachDiagnostics(this.page);
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async navigate(url: string): Promise<void> {
    const page = this.requirePage();

    // Treat a navigation as the beginning of a fresh observation period.
    this.errors = [];
    this.lastScreenshotPath = undefined;
    this.screenshotCapturedAt = undefined;

    await page.goto(url, {
      waitUntil: "domcontentloaded",
    });
    // Client-rendered apps can finish DOMContentLoaded before their first screen appears.
    await page.waitForFunction(() => !!document.body?.innerText.trim(), undefined, { timeout: 3_000 }).catch(() => {});
  }

  async act(action: QAAction): Promise<QAActionOutcome> {
    const page = this.requirePage();
    if (page.isClosed()) {
      throw new Error("Playwright page is closed");
    }

    try {
      switch (action.type) {
        case "navigate":
          await this.navigate(action.url);
          break;
        case "click":
          if (action.target.by === "coordinates") {
            await page.mouse.click(action.target.x, action.target.y);
          } else {
            await this.resolveTarget(page, action.target).click();
          }
          break;
        case "fill":
          await this.resolveTarget(page, action.target).fill(action.value);
          break;
        case "select":
          await this.resolveTarget(page, action.target).selectOption(action.value);
          break;
        case "press":
          await this.resolveTarget(page, action.target).press(action.key);
          break;
        case "scroll":
          await page.mouse.wheel(action.deltaX ?? 0, action.deltaY);
          break;
        case "screenshot":
          await this.screenshot(action.path);
          break;
        default:
          throw new Error(`Unsupported action type: ${String((action as { type: string }).type)}`);
      }
      return { success: true };
    } catch (error) {
      if (page.isClosed() || !this.browser?.isConnected()) {
        throw new Error("Playwright environment became unavailable", { cause: error });
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async observe(): Promise<QAObservation> {
    const page = this.requirePage();

    const url = page.url();

    const [title, text, elements] = await Promise.all([
      page.title(),

      page
        .locator("body")
        .innerText()
        .catch(() => ""),

      this.collectElements(page),
    ]);

    let route: string | undefined;

    try {
      route = new URL(url).pathname;
    } catch {
      route = undefined;
    }

    return {
      platform: "web",

      location: {
        url,
        title,
        route,
      },

      text,

      elements,

      screenshot: this.lastScreenshotPath,

      errors: [...this.errors],
      diagnostics: [...this.diagnostics],
      screenshotCapturedAt: this.screenshotCapturedAt,
    };
  }

  async screenshot(path: string): Promise<void> {
    const page = this.requirePage();

    await mkdir(dirname(path), {
      recursive: true,
    });

    await page.screenshot({
      path,
      fullPage: false,
      mask: [page.locator('input[type="password"], [autocomplete="current-password"], [autocomplete="new-password"]')],
    });

    this.lastScreenshotPath = path;
    this.screenshotCapturedAt = new Date().toISOString();
  }

  async runtimeInfo(): Promise<{ version: string; viewport?: { width: number; height: number } }> {
    return { version: this.browser?.version() ?? "unknown", viewport: this.page?.viewportSize() ?? undefined };
  }

  async inspect(target: SemanticTarget): Promise<{ count: number; elements: QAElement[] }> {
    const locator = this.resolveTarget(this.requirePage(), target);
    const count = await locator.count();
    const elements: QAElement[] = [];
    for (let i = 0; i < Math.min(count, 20); i++) {
      const item = locator.nth(i);
      elements.push({
        role: await item.getAttribute("role") ?? (target.by === "role" ? target.role : undefined),
        label: await item.getAttribute("aria-label") ?? (target.by === "label" ? target.label : undefined),
        text: (await item.innerText().catch(() => "")).slice(0, 1000),
        value: await item.evaluate(node => node instanceof HTMLInputElement && node.type === "password").catch(() => false)
          ? "[redacted]" : await item.inputValue().catch(() => undefined),
        visible: await item.isVisible(),
        enabled: await item.isEnabled(),
      });
    }
    return { count, elements };
  }

  async close(): Promise<void> {
    const context = this.context;
    const browser = this.browser;

    this.page = undefined;
    this.context = undefined;
    this.browser = undefined;

    try {
      if (context) {
        if (this.options.tracePath) {
          await mkdir(dirname(this.options.tracePath), { recursive: true });
          await context.tracing.stop({ path: this.options.tracePath });
        }
        await context.close();
      }
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  private requirePage(): Page {
    if (!this.page) {
      throw new Error(
        "PlaywrightEnvironment has not been started. Call start() first.",
      );
    }

    return this.page;
  }

  private resolveTarget(page: Page, target: SemanticTarget): Locator {
    switch (target.by) {
      case "role":
        return page.getByRole(target.role as Parameters<Page["getByRole"]>[0], {
          name: target.name,
          exact: true,
        });
      case "label":
        return page.getByLabel(target.label, { exact: true });
      case "text":
        return page.getByText(target.text, { exact: true });
      case "testId":
        return page.getByTestId(target.id);
      case "css":
        return page.locator(target.selector);
    }
  }

  private attachDiagnostics(page: Page): void {
    // Omit all query values, credentials and fragments. Never capture bodies or headers.
    const safeUrl = (value: string) => {
      try { const url = new URL(value); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.href.slice(0, 1000); }
      catch { return "[unavailable URL]"; }
    };
    const record = (kind: QADiagnostic["kind"], message: string, request?: Request, status?: number) => {
      const identity = request ? this.requests.get(request) : undefined;
      this.diagnostics.push({ schemaVersion: 1, id: `diagnostic-${this.diagnostics.length + 1}`, source: "application",
        occurredAt: new Date().toISOString(), kind, message: message.slice(0, 1000),
        ...(request && identity ? { request: { ...identity, method: request.method(), url: safeUrl(request.url()), ...(status === undefined ? {} : { status }) } } : {}) });
    };
    page.on("request", request => this.requests.set(request, { id: `request-${++this.nextRequest}`, startedAt: new Date().toISOString() }));
    page.on("response", response => {
      if (response.status() >= 400) record("http_error", `HTTP ${response.status()}`, response.request(), response.status());
    });
    page.on("console", message => {
      if (message.type() === "error") { this.errors.push(`console: ${message.text()}`); record("console_error", "Browser console error (see recorded errors)"); }
    });
    page.on("pageerror", error => { this.errors.push(`pageerror: ${error.message}`); record("page_error", "Uncaught application error (see recorded errors)"); });
    page.on("requestfailed", request => {
      const message = `requestfailed: ${request.method()} ${safeUrl(request.url())} ${request.failure()?.errorText ?? ""}`;
      this.errors.push(message);
      record("transport_failure", request.failure()?.errorText ?? "Transport failure", request);
    });
  }

  private async collectElements(page: Page): Promise<QAElement[]> {
    return page
      .locator(
        [
          "a",
          "button",
          "input",
          "textarea",
          "select",
          "[role]",
          "[aria-label]",
          "[data-testid]",
        ].join(","),
      )
      .evaluateAll((nodes) => {
        function inferRole(element: HTMLElement): string | undefined {
          const explicitRole = element.getAttribute("role");

          if (explicitRole) {
            return explicitRole;
          }

          const tag = element.tagName.toLowerCase();

          if (tag === "a" && element.hasAttribute("href")) {
            return "link";
          }

          if (tag === "button") {
            return "button";
          }

          if (tag === "textarea") {
            return "textbox";
          }

          if (tag === "select") {
            return "combobox";
          }

          if (tag === "input") {
            const input = element as HTMLInputElement;

            switch (input.type) {
              case "button":
              case "submit":
              case "reset":
                return "button";

              case "checkbox":
                return "checkbox";

              case "radio":
                return "radio";

              default:
                return "textbox";
            }
          }

          return undefined;
        }

        return nodes.map((node) => {
          const element = node as HTMLElement;

          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();

          const visible =
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number.parseFloat(style.opacity || "1") > 0 &&
            rect.width > 0 &&
            rect.height > 0;

          const nativeDisabled =
            "disabled" in element &&
            Boolean((element as HTMLButtonElement).disabled);

          const ariaDisabled =
            element.getAttribute("aria-disabled") === "true";

          let label =
            element.getAttribute("aria-label")?.trim() || undefined;

          if (!label && "labels" in element) {
            const labels = (
              element as
                | HTMLInputElement
                | HTMLTextAreaElement
                | HTMLSelectElement
            ).labels;

            label = labels?.[0]?.textContent?.trim() || undefined;
          }

          let text: string | undefined;

          if (
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement
          ) {
            text = element instanceof HTMLInputElement && element.type === "password"
              ? "[redacted]" : element.value?.trim() || undefined;
          } else {
            text = element.innerText?.trim() || undefined;
          }

          return {
            id:
              element.getAttribute("data-testid") ||
              element.id ||
              undefined,

            role: inferRole(element),

            text,
            label,

            visible,
            enabled: !nativeDisabled && !ariaDisabled,
          };
        });
      });
  }
}
