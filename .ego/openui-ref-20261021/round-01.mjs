const task = await taskSpace("pace openui reference");
console.log({ spaceId: task.spaceId });
const page = task.page("p1");
await page.goto("https://www.openui.com/chat?form_factor=desktop", { waitUntil: "domcontentloaded" });
await page.waitForSelector("textarea", { timeout: 30000 });
const info = await page.evaluate(() => {
  const cs = (el) => el ? getComputedStyle(el) : null;
  const pick = (el, props) => { const s = cs(el); if (!s) return null; const o = {}; for (const p of props) o[p] = s[p]; return o; };
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const all = [...document.querySelectorAll("*")];
  const shell = all.find(e => parseFloat(cs(e)?.borderRadius || 0) >= 14 && e.getBoundingClientRect().width > 1000);
  const ta = document.querySelector("textarea");
  const composer = ta ? ta.closest("div")?.parentElement : null;
  const send = all.find(e => e.tagName === "BUTTON" && (e.getAttribute("aria-label") === "Send" || e.querySelector("svg.lucide-arrow-up")));
  const modelBtn = all.find(e => e.tagName === "BUTTON" && /Gemini|model/i.test(e.textContent || "") && e.getBoundingClientRect().height < 60);
  const chips = all.filter(e => e.tagName === "BUTTON" && e.getBoundingClientRect().height > 50 && e.getBoundingClientRect().height < 120 && e.getBoundingClientRect().width > 90 && e.getBoundingClientRect().width < 260);
  const h2s = [...document.querySelectorAll("h2,h3,div")].filter(e => /Good to see you|What's on your mind/i.test(e.textContent || "") && e.children.length === 0);
  return {
    body: pick(document.body, ["backgroundColor","fontFamily","fontSize","color"]),
    shell: { box: box(shell), ...pick(shell, ["backgroundColor","borderRadius","border","boxShadow"]) },
    composer: { box: box(composer), ...pick(composer, ["backgroundColor","borderRadius","border","boxShadow","padding"]) },
    textarea: pick(ta, ["backgroundColor","borderRadius","border","fontSize","padding","color","fontFamily"]),
    send: { box: box(send), ...pick(send, ["backgroundColor","borderRadius","color","width","height"]) },
    modelBtn: { box: box(modelBtn), ...pick(modelBtn, ["backgroundColor","borderRadius","fontSize","padding","color"]) },
    chips: chips.slice(0,3).map(c => ({ box: box(c), ...pick(c, ["backgroundColor","borderRadius","padding","fontSize","color"]) })),
    headings: h2s.slice(0,2).map(h => ({ text: (h.textContent||"").slice(0,40), ...pick(h, ["fontSize","fontWeight","color","lineHeight"]) })),
    fonts: [...new Set(all.slice(0,400).map(e => cs(e)?.fontFamily).filter(Boolean))].slice(0,5),
    radii: [...new Set(all.slice(0,600).map(e => cs(e)?.borderRadius).filter(v => v && v !== "0px"))].slice(0,15),
  };
});
console.log(JSON.stringify(info, null, 2));
