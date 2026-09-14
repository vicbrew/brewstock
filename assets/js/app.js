async function injectPartial(selector, url) {
  const host = document.querySelector(selector);
  if (!host) return;

  try {
    const res = await fetch(url, { cache: "no-cache" });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    host.innerHTML = await res.text();
  } catch (e) {
    // Fail silently but keep page usable
    console.warn(`Partial load failed: ${url}`, e);
  }
}

function wireNavToggle() {
  const toggle = document.querySelector(".nav__toggle");
  const links = document.querySelector("#nav-links");
  if (!toggle || !links) return;

  toggle.addEventListener("click", () => {
    const expanded = toggle.getAttribute("aria-expanded") === "true";
    toggle.setAttribute("aria-expanded", String(!expanded));
    links.classList.toggle("nav__links--open");
  });
}

function markActiveNav() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  document.querySelectorAll(".nav__links a").forEach(a => {
    const href = a.getAttribute("href")?.replace(/\/+$/, "");
    if (href && (href === path || (path === "/" && href === "/launch.html"))) {
      a.setAttribute("aria-current", "page");
    }
  });
}

function setYear() {
  const el = document.getElementById("year");
  if (el) el.textContent = new Date().getFullYear();
}

(async function init() {
  await injectPartial("#site-nav", "/partials/nav.html");
  await injectPartial("#site-footer", "/partials/footer.html");
  wireNavToggle();
  markActiveNav();
  setYear();
})();