/* ============================================================================
   TrustedBySuburb — Recent Sales widget (tbs-property.js)
   ----------------------------------------------------------------------------
   Renders recent local sales from the Harcourts REAXML feed on suburb pages.

   Embed on a suburb page:

     <div id="tbs-recent-sales" data-suburb="The Gap" data-limit="6"></div>
     <script src="https://cdn.jsdelivr.net/gh/Wingingit11/tbs-data@main/js/tbs-property.js"></script>

   Data source: property/sold.json in the tbs-data repo (via jsDelivr).
   Styling: self-contained, injected once. Dark navy base, mint/teal accents,
   DM Serif Display for the section heading — matches the TBS design system.
   Assumes DM Serif Display is already loaded by the page (it is on TBS
   suburb pages); falls back to Georgia/serif if not.
   ============================================================================ */
(function () {
  "use strict";

  var DATA_URL =
    "https://cdn.jsdelivr.net/gh/Wingingit11/tbs-data@main/property/sold.json";

  var MOUNT_ID = "tbs-recent-sales";

  /* ---------- styles (injected once) ---------- */
  var CSS = [
    "#tbs-recent-sales{--tbs-navy:#0d1b2e;--tbs-navy-2:#13233c;--tbs-mint:#4be3c0;--tbs-teal:#1fa98c;--tbs-text:#eaf2f0;--tbs-dim:#9db3ae;font-family:Inter,-apple-system,'Segoe UI',Roboto,sans-serif;}",
    "#tbs-recent-sales .tbsps-head{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap;margin:0 0 14px;}",
    "#tbs-recent-sales .tbsps-title{font-family:'DM Serif Display',Georgia,serif;font-size:1.55rem;line-height:1.2;color:var(--tbs-text);margin:0;}",
    "#tbs-recent-sales .tbsps-title em{color:var(--tbs-mint);font-style:normal;}",
    "#tbs-recent-sales .tbsps-src{font-size:.78rem;color:var(--tbs-dim);}",
    "#tbs-recent-sales .tbsps-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px;}",
    "#tbs-recent-sales .tbsps-card{background:linear-gradient(160deg,var(--tbs-navy-2),var(--tbs-navy));border:1px solid rgba(75,227,192,.18);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;transition:transform .18s ease,border-color .18s ease;}",
    "#tbs-recent-sales .tbsps-card:hover{transform:translateY(-3px);border-color:rgba(75,227,192,.45);}",
    "#tbs-recent-sales .tbsps-imgwrap{position:relative;aspect-ratio:16/10;background:#0a1626;}",
    "#tbs-recent-sales .tbsps-imgwrap img{width:100%;height:100%;object-fit:cover;display:block;}",
    "#tbs-recent-sales .tbsps-noimg{width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:var(--tbs-dim);font-size:.8rem;}",
    "#tbs-recent-sales .tbsps-badge{position:absolute;top:10px;left:10px;background:var(--tbs-mint);color:#08251d;font-weight:700;font-size:.7rem;letter-spacing:.06em;text-transform:uppercase;padding:4px 9px;border-radius:999px;}",
    "#tbs-recent-sales .tbsps-body{padding:13px 15px 15px;display:flex;flex-direction:column;gap:6px;}",
    "#tbs-recent-sales .tbsps-price{font-size:1.18rem;font-weight:700;color:var(--tbs-mint);}",
    "#tbs-recent-sales .tbsps-price.undisclosed{color:var(--tbs-dim);font-weight:600;font-size:1rem;}",
    "#tbs-recent-sales .tbsps-addr{color:var(--tbs-text);font-size:.95rem;font-weight:600;}",
    "#tbs-recent-sales .tbsps-meta{display:flex;gap:12px;color:var(--tbs-dim);font-size:.83rem;align-items:center;}",
    "#tbs-recent-sales .tbsps-meta svg{width:14px;height:14px;vertical-align:-2px;margin-right:3px;stroke:var(--tbs-teal);}",
    "#tbs-recent-sales .tbsps-date{margin-top:2px;font-size:.78rem;color:var(--tbs-dim);}",
    "#tbs-recent-sales .tbsps-cat{font-size:.75rem;color:var(--tbs-teal);text-transform:uppercase;letter-spacing:.05em;}",
    "#tbs-recent-sales .tbsps-empty{color:var(--tbs-dim);font-size:.9rem;padding:18px;border:1px dashed rgba(75,227,192,.25);border-radius:12px;text-align:center;}",
    "@media (prefers-reduced-motion:reduce){#tbs-recent-sales .tbsps-card{transition:none;}}"
  ].join("\n");

  /* ---------- tiny helpers ---------- */
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function money(n) {
    return "$" + Number(n).toLocaleString("en-AU");
  }

  function fmtDate(iso) {
    if (!iso) return "";
    var d = new Date(iso + "T00:00:00");
    if (isNaN(d)) return "";
    return d.toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" });
  }

  var ICONS = {
    bed: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M3 18v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6M3 18h18M5 10V7a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3"/></svg>',
    bath: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M4 12h16v2a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5v-2zM6 12V6a2 2 0 0 1 4 0"/></svg>',
    car: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2"><path d="M5 16l1.5-5A2 2 0 0 1 8.4 9.5h7.2a2 2 0 0 1 1.9 1.5L19 16M5 16h14M5 16v3M19 16v3"/><circle cx="8" cy="16" r="1"/><circle cx="16" cy="16" r="1"/></svg>'
  };

  function metaItem(icon, val, label) {
    if (val == null) return "";
    return "<span title='" + label + "'>" + ICONS[icon] + esc(val) + "</span>";
  }

  /* ---------- render ---------- */
  function render(mount, data) {
    var suburb = mount.getAttribute("data-suburb") || "";
    var limit = parseInt(mount.getAttribute("data-limit") || "6", 10);

    var sales = (data.sales || []).filter(function (s) {
      return !suburb || (s.address && s.address.suburb &&
        s.address.suburb.toLowerCase() === suburb.toLowerCase());
    }).slice(0, limit);

    var head = el("div", "tbsps-head");
    head.appendChild(el("h2", "tbsps-title",
      "Recent sales in <em>" + esc(suburb || "the area") + "</em>"));
    head.appendChild(el("div", "tbsps-src",
      "Sales data courtesy of " + esc(data.source || "our partner agents")));
    mount.appendChild(head);

    if (!sales.length) {
      mount.appendChild(el("div", "tbsps-empty",
        "No recent partner-agent sales to show for " + esc(suburb) +
        " just yet — check back soon."));
      return;
    }

    var grid = el("div", "tbsps-grid");
    sales.forEach(function (s) {
      var card = el("article", "tbsps-card");

      var imgwrap = el("div", "tbsps-imgwrap");
      if (s.image) {
        var img = document.createElement("img");
        img.src = s.image;
        img.alt = "Photo of " + (s.address ? s.address.street : "property");
        img.loading = "lazy";
        img.onerror = function () {
          imgwrap.innerHTML = "<div class='tbsps-noimg'>Photo unavailable</div>";
          imgwrap.appendChild(badge.cloneNode(true));
        };
        imgwrap.appendChild(img);
      } else {
        imgwrap.appendChild(el("div", "tbsps-noimg", "No photo"));
      }
      var badge = el("span", "tbsps-badge", "Sold");
      imgwrap.appendChild(badge);
      card.appendChild(imgwrap);

      var body = el("div", "tbsps-body");
      var sold = s.sold || {};
      var priceHtml, priceCls = "tbsps-price";
      if (sold.disclosed && sold.price) {
        priceHtml = money(sold.price);
      } else {
        priceHtml = "Price undisclosed";
        priceCls += " undisclosed";
      }
      body.appendChild(el("div", priceCls, priceHtml));

      var addrLine = s.address && s.address.display !== false
        ? s.address.street : "Address withheld";
      body.appendChild(el("div", "tbsps-addr", esc(addrLine)));

      if (s.category) body.appendChild(el("div", "tbsps-cat", esc(s.category)));

      var f = s.features || {};
      var meta = metaItem("bed", f.beds, "Bedrooms") +
                 metaItem("bath", f.baths, "Bathrooms") +
                 metaItem("car", f.cars, "Car spaces");
      if (meta) body.appendChild(el("div", "tbsps-meta", meta));

      if (sold.date) {
        body.appendChild(el("div", "tbsps-date", "Sold " + fmtDate(sold.date)));
      }

      card.appendChild(body);
      grid.appendChild(card);
    });
    mount.appendChild(grid);
  }

  /* ---------- boot ---------- */
  function init() {
    var mount = document.getElementById(MOUNT_ID);
    if (!mount) return;

    var style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    fetch(DATA_URL, { cache: "no-cache" })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (data) { render(mount, data); })
      .catch(function () {
        mount.appendChild(el("div", "tbsps-empty",
          "Recent sales are temporarily unavailable."));
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
