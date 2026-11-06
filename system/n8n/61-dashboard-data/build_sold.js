const sold = {}, rev = {};
let ok = 0;
for (const f of $input.all()) {
  let j; try { j = JSON.parse(f.json.data); } catch (e) { continue; }
  ok++;
  for (const l of (j.Lines || [])) {
    if (!l.Item) continue;
    const q = Number(l.Qty) || 0;
    sold[l.Item] = (sold[l.Item] || 0) + q;
    rev[l.Item] = (rev[l.Item] || 0) + q * (Number(l.SalesUnitPrice) || 0) - (Number(l.DiscountAmount) || 0);
  }
}
return [{ json: { ok: ok > 0, invoices: ok, sold, rev } }];
