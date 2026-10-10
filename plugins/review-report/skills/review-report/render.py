"""Render review findings JSON as a self-contained HTML page.

Usage: uv run --no-project python render.py findings.json out.html
"""

import html
import json
import re
import sys

SEVERITIES = ['critical', 'high', 'medium', 'low', 'nit']
VERDICTS = {
    'breaks-ac': 'Breaks AC',
    'in-scope': 'In scope',
    'out-of-scope': 'Out of scope',
    'pre-existing': 'Pre-existing',
    'no-ticket': 'No ticket',
}

CSS = """
:root{--bg:#fafafa;--fg:#1c1c1e;--muted:#6b6b70;--card:#fff;--line:#e3e3e6;--code:#f1f1f3;
--crit:#b3261e;--high:#d9480f;--med:#b8860b;--low:#2b6cb0;--nit:#6b6b70;--ok:#2f855a;--acc:#2b6cb0}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#161618;--fg:#ececef;--muted:#9a9aa1;
--card:#1f1f22;--line:#333338;--code:#2a2a2e;--crit:#ff6b60;--high:#ff8c42;--med:#e0b341;--low:#6aa8ff;
--nit:#9a9aa1;--ok:#5ccf8a;--acc:#6aa8ff}}
:root[data-theme="dark"]{--bg:#161618;--fg:#ececef;--muted:#9a9aa1;--card:#1f1f22;--line:#333338;--code:#2a2a2e;
--crit:#ff6b60;--high:#ff8c42;--med:#e0b341;--low:#6aa8ff;--nit:#9a9aa1;--ok:#5ccf8a;--acc:#6aa8ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",
sans-serif;padding:24px 16px}
main{max-width:1600px;margin:0 auto}
h1{font-size:22px;margin:0 0 4px}
.sub{color:var(--muted);margin:0 0 16px}
a{color:var(--acc)}
code{background:var(--code);padding:1px 4px;border-radius:4px;font:12.5px ui-monospace,SFMono-Regular,Menlo,
monospace;word-break:break-word}
.tickets{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px;margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.card h2{font-size:13px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);margin:0 0 6px}
.card ul{margin:6px 0 0;padding-left:18px}
.bar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;align-items:center}
.bar button{border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;
padding:4px 12px;cursor:pointer;font:inherit}
.bar button.on{border-color:var(--acc);box-shadow:inset 0 0 0 1px var(--acc)}
.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}
table{border-collapse:collapse;width:100%;min-width:1100px}
th,td{text-align:left;vertical-align:top;padding:10px 12px;border-bottom:1px solid var(--line)}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);position:sticky;top:0;
background:var(--card)}
tr:last-child td{border-bottom:0}
td.loc{width:15%}td.loc code{display:block;margin-bottom:4px}
td.fix ol{margin:0;padding-left:18px}td.fix li{margin-bottom:6px}
td.fix li:first-child::after{content:" ★ recommended";color:var(--ok);font-size:12px;white-space:nowrap}
.tag{display:inline-block;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.04em;
padding:2px 8px;border-radius:4px;color:#fff}
.sev-critical{background:var(--crit)}.sev-high{background:var(--high)}.sev-medium{background:var(--med)}
.sev-low{background:var(--low)}.sev-nit{background:var(--nit)}
.v{display:inline-block;font-size:11px;font-weight:600;padding:1px 6px;border-radius:4px;border:1px solid;
margin-bottom:4px}
.v-breaks-ac{color:var(--crit)}.v-in-scope{color:var(--ok)}.v-out-of-scope{color:var(--med)}
.v-pre-existing{color:var(--muted)}.v-no-ticket{color:var(--muted)}
.warn{color:var(--crit);font-weight:600}
"""

JS = """
const btns=document.querySelectorAll('.bar button');
btns.forEach(b=>b.addEventListener('click',()=>{
  const s=b.dataset.sev;btns.forEach(x=>x.classList.toggle('on',x===b));
  document.querySelectorAll('tbody tr').forEach(r=>{r.hidden=s!=='all'&&r.dataset.sev!==s;});
}));
"""


def fmt(text: str | None) -> str:
    """
    Escape text and turn `backticks` into <code> and newlines into <br>.

    :param text: raw text from the JSON
    :return: safe HTML fragment
    """
    escaped = html.escape(text or '')
    escaped = re.sub(r'`([^`]+)`', r'<code>\1</code>', escaped)
    return escaped.replace('\n', '<br>')


def ticket_card(label: str, ticket: dict | None) -> str:
    """
    Render one Jira ticket card.

    :param label: card heading, e.g. "Ticket" or "Parent"
    :param ticket: ticket dict or None
    :return: HTML fragment
    """
    if not ticket:
        return f'<div class="card"><h2>{label}</h2><span style="color:var(--muted)">None</span></div>'
    key = html.escape(ticket.get('key', '?'))
    url = ticket.get('url')
    head = f'<a href="{html.escape(url)}">{key}</a>' if url else key
    meta = ' · '.join(html.escape(ticket[k]) for k in ('type', 'status') if ticket.get(k))
    criteria = ''.join(f'<li>{fmt(c)}</li>' for c in ticket.get('criteria') or [])
    return (
        f'<div class="card"><h2>{label}</h2><strong>{head}</strong> {fmt(ticket.get("summary"))}'
        f'<div style="color:var(--muted)">{meta}</div>'
        f'{f"<ul>{criteria}</ul>" if criteria else ""}</div>'
    )


def finding_row(finding: dict) -> str:
    """
    Render one table row.

    :param finding: finding dict
    :return: HTML <tr>
    """
    severity = finding.get('severity', 'medium').lower()
    locations = finding.get('locations') or [finding.get('location', '?')]
    locs = ''.join(f'<code>{html.escape(loc)}</code>' for loc in locations)
    check = finding.get('ticket_check') or {}
    verdict = check.get('verdict', 'no-ticket')
    fixes = finding.get('fixes') or []
    fix_items = ''.join(f'<li>{fmt(f)}</li>' for f in fixes)
    warn = '' if len(fixes) == 3 else f'<div class="warn">Expected 3 fixes, got {len(fixes)}</div>'
    return (
        f'<tr data-sev="{severity}">'
        f'<td class="loc">{locs}<span class="tag sev-{severity}">{severity}</span></td>'
        f'<td>{fmt(finding.get("issue"))}</td>'
        f'<td>{fmt(finding.get("impact"))}</td>'
        f'<td>{fmt(finding.get("evidence"))}</td>'
        f'<td><span class="v v-{verdict}">{VERDICTS.get(verdict, html.escape(verdict))}</span><br>'
        f'{fmt(check.get("note"))}</td>'
        f'<td class="fix">{warn}<ol>{fix_items}</ol></td></tr>'
    )


def render(data: dict) -> str:
    """
    Render the full page.

    :param data: parsed findings JSON
    :return: HTML document
    """
    findings = sorted(
        data.get('findings') or [],
        key=lambda f: (
            SEVERITIES.index(f.get('severity', 'medium').lower())
            if f.get('severity', 'medium').lower() in SEVERITIES
            else len(SEVERITIES),
            (f.get('locations') or [f.get('location', '')])[0],
        ),
    )
    counts = {s: sum(1 for f in findings if f.get('severity', '').lower() == s) for s in SEVERITIES}
    buttons = f'<button data-sev="all" class="on">All {len(findings)}</button>' + ''.join(
        f'<button data-sev="{s}"><span class="tag sev-{s}">{s}</span> {n}</button>' for s, n in counts.items() if n
    )
    sub = ' · '.join(fmt(data[k]) for k in ('target', 'reviewed_at') if data.get(k))
    note = f'<p class="sub">{fmt(data["note"])}</p>' if data.get('note') else ''
    rows = ''.join(finding_row(f) for f in findings) or '<tr><td colspan="6">No findings.</td></tr>'
    title = html.escape(data.get('title', 'Review findings'))
    return f"""<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title}</title><style>{CSS}</style></head><body><main>
<h1>{title}</h1><p class="sub">{sub}</p>{note}
<div class="tickets">{ticket_card('Ticket', data.get('ticket'))}{ticket_card('Parent', data.get('parent'))}</div>
<div class="bar">{buttons}</div>
<div class="wrap"><table><thead><tr><th>Location / severity</th><th>Issue</th><th>What goes wrong</th>
<th>Evidence</th><th>Ticket check</th><th>3 fixes</th></tr></thead><tbody>{rows}</tbody></table></div>
</main><script>{JS}</script></body></html>
"""


def main() -> None:
    if len(sys.argv) != 3:
        sys.exit('usage: render.py findings.json out.html')
    with open(sys.argv[1], encoding='utf-8') as fh:
        data = json.load(fh)
    with open(sys.argv[2], 'w', encoding='utf-8') as fh:
        fh.write(render(data))
    print(sys.argv[2])


if __name__ == '__main__':
    main()
