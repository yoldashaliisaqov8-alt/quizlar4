# Qidiruv indeksi: s/tests.json + s/XX.json (256 ta bo'lak)
import json, re, os, glob, collections
R = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
STOP = set("qaysi bilan uchun yilda aniqlang toping topin javob berilgan quyidagi ularning ushbu davrida hamda yillarda qanday nima kimning kim nechta asrda asrning bo'lgan bolgan edi etdi qilgan yil yili tomonidan haqida".split())
def norm(s):
    s = s.lower()
    s = re.sub(r"[‘’ʻʼ`´'\"]", "", s)
    return [t for t in re.findall(r"[^\W_]+", s) if len(t) >= 3 and t not in STOP]
def shard(key):
    h = 5381
    for ch in key[:2]:
        h = ((h * 33) ^ ord(ch)) & 0xFFFFFFFF
    return '%02x' % (h % 256)
cat = json.load(open(os.path.join(R, 'catalog.json'), encoding='utf-8'))
names = [t['n'] for s in cat['sections'] for t in s['tests']]
post = collections.defaultdict(set)
for ti, n in enumerate(names):
    d = json.load(open(os.path.join(R, n + '.json'), encoding='utf-8'))
    for qi, q in enumerate(d['questions']):
        for tok in set(norm(q['q'] + ' ' + ' '.join(map(str, q['options'])))):
            post[tok[:6]].add(ti * 1000 + qi)
shards = collections.defaultdict(dict)
for k, v in post.items():
    shards[shard(k)][k] = sorted(v)
os.makedirs(os.path.join(R, 's'), exist_ok=True)
for f in glob.glob(os.path.join(R, 's', '*.json')): os.remove(f)
json.dump(names, open(os.path.join(R, 's', 'tests.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
for sh, m in shards.items():
    json.dump(m, open(os.path.join(R, 's', sh + '.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(len(names), 'test,', len(post), 'kalit,', len(shards), "bo'lak")
