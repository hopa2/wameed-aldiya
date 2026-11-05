#!/usr/bin/env python3
"""يولّد system/db/004_prompts.sql من ملف «منظومة-وكلاء-وميض-الضياء.md».

الاستخدام:
  python3 build_prompts.py <مسار ملف المنظومة.md> > ../db/004_prompts.sql

يأخذ أول كتلة ``` بعد كل عنوان «## (N)»، فيضع الدستور (0) في config
وأمر كل وكيل في agents.system_prompt، فقط إذا كان فارغًا (لا يكتب فوق تعديلك).
"""
import re, sys

SECTIONS = {0: None, 1: 'orchestrator', 2: 'sales_agent', 3: 'inventory_agent',
            4: 'pricing_agent', 5: 'finance_agent', 6: 'customer_service',
            7: 'marketing_agent', 8: 'hr_agent', 9: 'supplier_agent'}

def blocks(md):
    out = {}
    for m in re.finditer(r'^## \((\d+)\)[^\n]*\n(.*?)(?=^## \(|\Z)', md, re.S | re.M):
        n = int(m.group(1))
        code = re.search(r'```[a-z]*\n(.*?)\n```', m.group(2), re.S)
        if n in SECTIONS and code:
            out[n] = code.group(1).strip()
    return out

def q(text):
    tag = '$wameed$'
    assert tag not in text
    return tag + text + tag

def main(path):
    b = blocks(open(path, encoding='utf-8').read())
    missing = [n for n in SECTIONS if n not in b]
    if missing:
        sys.exit(f'sections not found: {missing}')
    print('-- مولَّد آليًا من ملف المنظومة بواسطة scripts/build_prompts.py. لا تعدّله يدويًا.')
    print('SET search_path = wameed, public;\n')
    print("INSERT INTO config (key, value, label_ar, group_ar, sort) VALUES ('constitution', to_jsonb("
          + q(b[0]) + "::text), 'الدستور المشترك (أول كل أمر)', 'الأوامر', 95) ON CONFLICT (key) DO NOTHING;\n")
    for n, agent in SECTIONS.items():
        if agent:
            print(f"UPDATE agents SET system_prompt = {q(b[n])} WHERE name = '{agent}' AND system_prompt IS NULL;\n")

if __name__ == '__main__':
    main(sys.argv[1])
