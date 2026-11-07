// نتيجة المنفّذ ← صف تحديث لسجل الإجراءات (نفس منطق ADS-30)
return $input.all().map(i => {
  const r = i.json;
  const status = r.ok ? (r.validate_only ? 'dry_run' : 'executed') : 'failed';
  return { json: {
    action_id: r.action_id, status,
    prev_state: r.prev_state, created_resource: r.created_resource,
    api_request: r.request, api_response: r.response,
    error: r.ok ? null : (r.validate_only ? 'فحص فقط: ' : '') + r.error
  } };
});
