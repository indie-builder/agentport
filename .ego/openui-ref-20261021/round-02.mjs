const resumed = await taskSpace("pace openui reference");
const page = resumed.page("p1");
const info = await page.evaluate(() => {
  const cs = (el) => el ? getComputedStyle(el) : null;
  const pick = (el, props) => { const s = cs(el); if (!s) return null; const o = {}; for (const p of props) o[p] = s[p]; return o; };
  const box = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const all = [...document.querySelectorAll("*")];
  const ta = document.querySelector("textarea");
  // 输入框外壳：包含 textarea 且圆角 >= 20 的最近祖先
  let wrapper = null;
  for (let el = ta; el; el = el.parentElement) {
    if (parseFloat(cs(el)?.borderRadius || 0) >= 20) { wrapper = el; break; }
  }
  // 侧栏
  const sideBtn = all.find(e => e.tagName === "BUTTON" && /New chat|新建/i.test(e.textContent || ""));
  // 页面外层背景（body 的父级或 html）
  const htmlCs = getComputedStyle(document.documentElement);
  // 第二行标题
  const second = all.filter(e => e.children.length === 0 && /What's on your mind/i.test(e.textContent || ""))[0];
  return {
    htmlBg: htmlCs.backgroundColor,
    bodyBg: cs(document.body).backgroundColor,
    // 外壳相对视口的边距
    shellMargin: (() => { const s = all.find(e => parseFloat(cs(e)?.borderRadius || 0) >= 14 && e.getBoundingClientRect().width > 1000); return s ? { rect: box(s), m: cs(s).margin, bg: cs(s).backgroundColor, radius: cs(s).borderRadius, border: cs(s).border } : null; })(),
    wrapper: wrapper ? { box: box(wrapper), ...pick(wrapper, ["backgroundColor","borderRadius","border","boxShadow","padding","height"]) } : null,
    placeholderColor: ta ? getComputedStyle(ta, "::placeholder").color : null,
    secondLine: second ? pick(second, ["fontSize","fontWeight","color","lineHeight"]) : null,
    sideBtn: sideBtn ? { box: box(sideBtn), ...pick(sideBtn, ["backgroundColor","borderRadius","fontSize","fontWeight","padding","color"]) } : null,
    iconSizes: [...new Set(all.filter(e => e.tagName === "svg").map(e => Math.round(e.getBoundingClientRect().width)))].sort((a,b)=>a-b),
  };
});
console.log(JSON.stringify(info, null, 2));
