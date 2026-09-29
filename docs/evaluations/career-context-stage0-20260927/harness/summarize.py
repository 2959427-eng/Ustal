import json,sys,glob
prefix=sys.argv[1]
lab={c['case_id']:c['expected_label'] for c in json.load(open('holdout.json'))['cases']}
res={}
for f in glob.glob(prefix+'-*.json'): res.update(json.load(open(f)))
tp=tn=fp=fn=err=0; bad=[]
for k,l in sorted(lab.items()):
    r=res.get(k)
    if not r or 'error' in r: err+=1; bad.append((k,'ERR',(r or {}).get('error','missing')[:120])); continue
    d=r['decision']
    if l=='MATCH' and d=='MATCH': tp+=1
    elif l=='REJECT' and d=='REJECT': tn+=1
    elif l=='REJECT': fp+=1; bad.append((k,'FP',r.get('reason')))
    else: fn+=1; bad.append((k,'FN',r.get('reason'), (r.get('review') or {}).get('hardConflict')))
p=tp/(tp+fp) if tp+fp else 0; rc=tp/(tp+fn) if tp+fn else 0
print(f"{prefix}: TP={tp} TN={tn} FP={fp} FN={fn} ERR={err} P={p:.3f} R={rc:.3f} F1={2*p*rc/(p+rc) if p+rc else 0:.3f}")
for b in bad: print('  ',b)
