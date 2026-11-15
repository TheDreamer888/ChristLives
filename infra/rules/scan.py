import yara, os, time, math
rules = yara.compile(filepath='infra/rules/malware.yar')
def entropy(data):
    from collections import Counter
    if not data: return 0
    c = Counter(data)
    l = len(data)
    return -sum((count/l)*math.log2(count/l) for count in c.values())

for root,_,files in os.walk("."):
    for f in files:
        if f.endswith((".js",".py",".ts",".exe")):
            path=os.path.join(root,f)
            try:
                data=open(path,'rb').read(4096)
                start=time.time()
                matches=rules.match(data=data)
                ms=(time.time()-start)*1000
                if matches or entropy(data)>7.5:
                    print(f"[BLOQUEIO {ms:.2f}ms] {path} -> {matches} ENT={entropy(data):.1f}")
            except: pass
