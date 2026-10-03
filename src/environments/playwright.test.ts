import { expect, test } from "bun:test";
import { PlaywrightEnvironment } from "./playwright";

test("HTTP and transport diagnostics retain identity, timing and redacted request metadata", async () => {
  const server = Bun.serve({ port: 0, fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/save" || url.pathname === "/background") return new Response("private response", { status: 500 });
    return new Response(`<body><button onclick="fetch('/save?token=private-token',{method:'POST',body:'private body'}).then(()=>document.querySelector('p').textContent='Save failed')">Save</button><p>Unsaved</p><script>fetch('/background?customer=private-customer');fetch('http://127.0.0.1:1/transport?secret=private-secret').catch(()=>{});</script></body>`, { headers: { "content-type": "text/html" } });
  } });
  const environment = new PlaywrightEnvironment();
  try {
    await environment.start(); await environment.navigate(server.url.href);
    await environment.act({ type: "click", target: { by: "text", text: "Save" } });
    let observation = await environment.observe();
    for (let n = 0; n < 30 && !observation.diagnostics?.some(e => e.request?.url.endsWith("/save")); n++) {
      await Bun.sleep(20); observation = await environment.observe();
    }
    const events = observation.diagnostics!;
    expect(events.some(e => e.kind === "http_error" && e.request?.status === 500 && e.request.url.endsWith("/save") && e.request.method === "POST")).toBe(true);
    expect(events.some(e => e.kind === "http_error" && e.request?.url.endsWith("/background"))).toBe(true);
    expect(events.some(e => e.kind === "transport_failure")).toBe(true);
    expect(events.every(e => Number.isFinite(Date.parse(e.occurredAt)))).toBe(true);
    expect(JSON.stringify(events)).not.toContain("private");
    expect(observation.errors.some(e => e.includes("HTTP 500"))).toBe(false);
    expect((await environment.observe()).diagnostics).toEqual(events);
    const path = `/tmp/qawarness-diagnostics-${crypto.randomUUID()}.png`;
    await environment.screenshot(path);
    expect((await environment.observe()).screenshotCapturedAt).toBeDefined();
    await Bun.file(path).delete();
  } finally { await environment.close(); server.stop(true); }
});
