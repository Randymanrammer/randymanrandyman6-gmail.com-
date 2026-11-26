const config = require('./config');
const { esc } = require('./email');
const features = require('./features');

const CSS = `
:root{--bg:#f7f8fb;--fg:#12151c;--mut:#5d6472;--card:#fff;--line:#e3e6ee;--acc:#0a66c2;--accfg:#fff;--ok:#127a3e;--warn:#9a5b00;--bad:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0e1015;--fg:#eceef3;--mut:#a2a8b5;--card:#171a21;--line:#2a2f3a;--acc:#4ea1ff;--accfg:#06121f;--ok:#4cc38a;--warn:#f0b45b;--bad:#ff7b72}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:860px;margin:auto;padding:16px}
nav{display:flex;gap:14px;align-items:center;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--line);background:var(--card)}
nav .brand{font-weight:700;margin-right:auto;color:var(--fg);text-decoration:none}
a{color:var(--acc)}h1{font-size:clamp(26px,6vw,40px);line-height:1.15;margin:.3em 0}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin:14px 0}
.btn,button{display:inline-block;background:var(--acc);color:var(--accfg);border:0;border-radius:10px;padding:12px 18px;font:inherit;font-weight:600;cursor:pointer;text-decoration:none;min-height:44px}
.btn.sec,button.sec{background:transparent;color:var(--acc);border:1px solid var(--acc)}
button.danger{background:var(--bad);color:#fff}button:disabled{opacity:.45;cursor:not-allowed}
input,textarea{width:100%;padding:11px;border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--fg);font:inherit;margin:4px 0 12px}
label{font-weight:600;font-size:14px}.check{display:flex;gap:10px;align-items:flex-start;font-weight:500}.check input{width:22px;height:22px;margin:2px 0}
.mut{color:var(--mut)}.ok{color:var(--ok)}.warn{color:var(--warn)}.bad{color:var(--bad)}
.price{font-size:15px;border-left:4px solid var(--acc);padding:10px 12px;background:var(--bg);border-radius:6px}
.meter{height:10px;background:var(--line);border-radius:99px;overflow:hidden}.meter>i{display:block;height:100%;background:var(--acc)}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:8px 6px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.pill{font-size:12px;padding:2px 9px;border-radius:99px;border:1px solid currentColor}
.flash{padding:12px;border-radius:10px;background:var(--card);border:1px solid var(--acc)}
.scroll{overflow-x:auto}
`;

function page(title, body, { user, flash } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} - ${esc(config.brand)}</title><style>${CSS}</style></head><body>
<nav><a class="brand" href="/">${esc(config.brand)}</a>${user ? `<a href="/dashboard">Dashboard</a><a href="/billing">Billing</a>${user.isOwner ? '<a href="/owner">Owner</a>' : ''}<form method="post" action="/logout" style="margin:0"><button class="sec" style="padding:6px 12px;min-height:0">Sign out</button></form>` : '<a href="/login">Sign in</a>'}</nav>
<main class="wrap">${flash ? `<p class="flash" role="status">${esc(flash)}</p>` : ''}${body}</main></body></html>`;
}

function featureList() {
  const live = features.filter((f) => f.tested);
  const soon = features.filter((f) => !f.tested);
  return `${live.length ? `<h3>Included</h3><ul>${live.map((f) => `<li>${esc(f.label)}</li>`).join('')}</ul>` : ''}
${soon.length ? `<h3>Coming soon</h3><ul class="mut">${soon.map((f) => `<li>${esc(f.label)} - Coming soon</li>`).join('')}</ul>` : ''}`;
}

function home({ stripeConnected, user }) {
  return page('Websites for your business', `
<h1>Your business online, built and hosted for you.</h1>
<p class="mut">${esc(config.businessName)}</p>
<div class="card">
  <h2 style="margin-top:0">Membership</h2>
  <p class="price"><b>${esc(config.disclosure)}</b></p>
  ${stripeConnected ? `
  <form method="post" action="/checkout" id="go">
    <label for="email">Email (optional, Stripe will ask if blank)</label>
    <input id="email" name="email" type="email" autocomplete="email">
    <label class="check"><input type="checkbox" name="agree" value="yes" id="agree"> <span>I agree: ${esc(config.disclosure)}</span></label>
    <p><button id="start" type="submit" disabled>Get Started</button></p>
  </form>
  <script>document.getElementById('agree').addEventListener('change',e=>{document.getElementById('start').disabled=!e.target.checked})</script>`
    : '<p><button disabled>Get Started</button> <span class="warn">Payments: Not connected</span></p>'}
</div>
<div class="card">${featureList()}</div>`, { user });
}

module.exports = { page, home, esc };
