"""Official live patch collector. No dependencies; never executes publisher content."""
import argparse, hashlib, json, os, re, tempfile
from datetime import datetime, timezone, timedelta
from html.parser import HTMLParser
from pathlib import Path
from urllib.request import Request, urlopen

ORIGIN='https://overwatch.blizzard.com'
HERO_IDS='dmon dva genji domina doctrine doomfist ramattra lifeweaver reinhardt wrecking-ball roadhog lucio reaper mauga mercy mei moira mizuki bastion baptiste vendetta venture brigitte sojourn soldier-76 sombra sigma symmetra sierra shion ana anran ashe echo emre orisa wuyang widowmaker winston illari zarya junker-queen junkrat jetpack-cat zenyatta juno cassidy kiriko torbjorn tracer pharah freja hanzo hazard'.split()
normalize=lambda s: re.sub('[^a-z0-9]','',s.lower())
HERO_ALIASES={normalize(h):h for h in HERO_IDS}
class Node:
    def __init__(self,tag='',attrs=(),parent=None):self.tag=tag;self.attrs=dict(attrs);self.parent=parent;self.children=[];self.parts=[]
    def has(self,cls):return cls in self.attrs.get('class','').split()
    def all(self,cls):return [n for n in self.descendants() if n.has(cls)]
    def descendants(self):
        for child in self.children:yield child;yield from child.descendants()
    def text(self):return re.sub(r'\s+',' ',''.join(self.parts)).strip()
class Tree(HTMLParser):
    def __init__(self):super().__init__(convert_charrefs=True);self.root=Node();self.current=self.root
    def handle_starttag(self,tag,attrs):
        child=Node(tag,attrs,self.current);self.current.children.append(child)
        if tag not in {'img','br','meta','link','input','hr','source','wbr'}:self.current=child
    def handle_endtag(self,tag):
        n=self.current
        while n.parent:
            if n.tag==tag:self.current=n.parent;return
            n=n.parent
    def handle_data(self,data):
        n=self.current
        while n:n.parts.append(data);n=n.parent

STATS={'Damage':('damage','피해'),'Healing':('healing','치유'),'Damage and healing':('damage-healing','피해·치유'),'Cooldown':('cooldown','재사용 대기시간'),'Duration':('duration','지속 시간'),'Max duration':('max-duration','최대 지속 시간'),'Center projectile damage':('center-damage','중앙 투사체 피해'),'Explosion damage':('explosion-damage','폭발 피해'),'Damage reduction':('damage-reduction','피해 감소'),'Base health':('health','기본 생명력'),'Base armor':('armor','기본 방어력'),'Base shields':('shields','기본 보호막')}
NUMBER=re.compile(r'^(.+?) (increased|reduced|decreased) from (\d+(?:\.\d+)?)(%?) to (\d+(?:\.\d+)?)(%?)(?: (seconds?|meters?))?\.$')
def classify(hero_id,ability,text):
    if re.search(r'6\s*(?:v|vs)\s*6|stadium',text,re.I):return None
    m=NUMBER.fullmatch(text)
    if not hero_id or not m or m[1] not in STATS:return {'heroId':hero_id,'ability':ability,'reason':'기술·역할·규칙 또는 미지원 수치 변경 검토 필요'}
    stat,label=STATS[m[1]];before=float(m[3]);after=float(m[5])
    if (m[2]=='increased' and after<=before) or (m[2]!='increased' and after>=before) or m[4]!=m[6]:
        return {'heroId':hero_id,'ability':ability,'reason':'수치 방향·단위 검토 필요'}
    unit='%' if m[4] else '초' if (m[7] or '').startswith('second') else 'm' if (m[7] or '').startswith('meter') else ''
    if stat in {'health','armor','shields'} and ability:return {'heroId':hero_id,'ability':ability,'reason':'기본 수치와 기술 수치의 범위 검토 필요'}
    if not ability and stat not in {'health','armor','shields'}:return {'heroId':hero_id,'ability':None,'reason':'기술 대상 검토 필요'}
    return {'heroId':hero_id,'ability':ability,'stat':stat,'label':label,'from':before,'to':after,'unit':unit}

def parse_notes(content,url):
    tree=Tree();tree.feed(content)
    blocks=tree.root.all('PatchNotes-patch');notes=[]
    if not blocks:raise ValueError('Official patch markup missing')
    for block in blocks:
        anchors=[n.attrs.get('id','') for n in block.descendants() if re.fullmatch(r'patch-\d{4}-\d{2}-\d{2}',n.attrs.get('id',''))]
        if len(anchors)!=1:raise ValueError('Ambiguous patch date')
        date=anchors[0][6:];facts=[];pending=[];recognized=0
        for section in block.all('PatchNotes-section'):
            if section.has('PatchNotes-section-hero_update'):
                updates=section.all('PatchNotesHeroUpdate')
                for hero in updates:
                    names=hero.all('PatchNotesHeroUpdate-name')
                    if len(names)!=1:raise ValueError('Ambiguous hero')
                    hid=HERO_ALIASES.get(normalize(names[0].text()))
                    for group in hero.all('PatchNotesHeroUpdate-generalUpdates'):
                        for li in [n for n in group.descendants() if n.tag=='li']:
                            recognized+=1;item=classify(hid,None,li.text())
                            if item:(facts if 'stat' in item else pending).append(item)
                    for ability in hero.all('PatchNotesAbilityUpdate'):
                        names=ability.all('PatchNotesAbilityUpdate-name')
                        if len(names)!=1:raise ValueError('Ambiguous ability')
                        for group in ability.all('PatchNotesAbilityUpdate-detailList'):
                            for li in [n for n in group.descendants() if n.tag=='li']:
                                recognized+=1;item=classify(hid,names[0].text(),li.text())
                                if item:(facts if 'stat' in item else pending).append(item)
                # General hero changes and rework sections cannot disappear silently.
                general=[n for n in section.descendants() if n.tag=='li' and not any_parent(n,'PatchNotesHeroUpdate')]
                if general:pending.append({'heroId':None,'ability':None,'reason':'영웅 공통 규칙 변경 검토 필요'})
            elif section.has('PatchNotes-section-map_update') or section.has('PatchNotes-section-bug_fix'):
                if section.text():pending.append({'heroId':None,'ability':None,'reason':'맵·게임 판정 변경 검토 필요'})
        if not recognized and not pending:
            # Cosmetic-only patches are detected, with no invented balance changes.
            titles=block.all('PatchNotes-sectionTitle')
            if any(re.search('hero|balance|map',n.text(),re.I) for n in titles):raise ValueError('Hero section changed; refusing incomplete update')
        digest=hashlib.sha256(block.text().encode()).hexdigest()
        notes.append({'date':date,'sourceUrl':url,'sourceSHA256':digest,'facts':facts,'pending':pending})
    return notes

def any_parent(node,cls):
    node=node.parent
    while node:
        if node.has(cls):return True
        node=node.parent
    return False

def validate(snapshot):
    if snapshot.get('schemaVersion')!=1 or snapshot.get('baselineDate')!='2026-10-13':raise ValueError('Unexpected patch schema/baseline')
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}',snapshot.get('latestDate','')):raise ValueError('Invalid latest date')
    if not isinstance(snapshot.get('patches'),list) or len(snapshot['patches'])>1000:raise ValueError('Invalid patch history')
    seen=set()
    for patch in snapshot['patches']:
        if patch['date'] in seen:raise ValueError('Duplicate patch date')
        seen.add(patch['date'])
        if not re.fullmatch(r'https://overwatch\.blizzard\.com/en-us/news/patch-notes/live/\d{4}/\d{2}/',patch['sourceUrl']):raise ValueError('Non-official source')
        if patch['date']<snapshot['baselineDate'] or patch['date']>snapshot['latestDate']:raise ValueError('Patch outside history')
        if not isinstance(patch['facts'],list) or not isinstance(patch['pending'],list) or len(patch['facts'])+len(patch['pending'])>1000:raise ValueError('Invalid changes')
        for fact in patch['facts']:
            if fact['heroId'] not in HERO_IDS or fact['stat'] not in {x[0] for x in STATS.values()}:raise ValueError('Unknown fact scope')
            if fact['unit'] not in {'','%','秒','초','m'}:raise ValueError('Unknown unit')
            for key in ['from','to']:
                value=fact[key]
                if not isinstance(value,(float,int)) or not 0<=value<=100000:raise ValueError('Invalid coefficient')
            if fact['ability'] is not None and (not isinstance(fact['ability'],str) or len(fact['ability'])>150):raise ValueError('Invalid ability')
    if seen and max(seen)!=snapshot['latestDate']:raise ValueError('Latest date mismatch')
    return snapshot

def merge(previous,notes,now):
    old=validate(previous);by_date={p['date']:p for p in old['patches']}
    today=now.date().isoformat()
    for p in notes:
        if p['date']>today:raise ValueError('Future official date')
        if p['date']>=old['baselineDate']:by_date[p['date']]=p
    patches=sorted(by_date.values(),key=lambda x:x['date'])
    new={**old,'latestDate':max([old['baselineDate'],*[p['date'] for p in patches]]),'patches':patches}
    if new!=old:new['detectedAt']=now.isoformat()
    return validate(new)

def collect(previous,now,fetch):
    months={now.strftime('%Y/%m'),(now.replace(day=1)-timedelta(days=1)).strftime('%Y/%m')};notes=[]
    for month in sorted(months):
        url=f'{ORIGIN}/en-us/news/patch-notes/live/{month}/'
        content=fetch(url)
        if len(content)>2_000_000:raise ValueError('Official response too large')
        notes+=parse_notes(content,url)
    return merge(previous,notes,now)

def fetch(url):
    with urlopen(Request(url,headers={'User-Agent':'Mozilla/5.0 (JOHAP official patch check)','Accept':'text/html'}),timeout=25) as response:
        if response.geturl()!=url:raise ValueError('Unexpected official redirect')
        return response.read(2_000_001).decode('utf-8')

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--refresh',action='store_true');parser.add_argument('--file',default='data/live-patches.json');args=parser.parse_args()
    file=Path(args.file);previous=validate(json.loads(file.read_text()))
    if not args.refresh:print('Patch snapshot valid');return
    result=collect(previous,datetime.now(timezone.utc),fetch)
    if result==previous:print('Official patch unchanged; no write');return
    file.parent.mkdir(parents=True,exist_ok=True)
    fd,tmp=tempfile.mkstemp(prefix='live-patches-',dir=file.parent)
    try:
        with os.fdopen(fd,'w') as out:json.dump(result,out,ensure_ascii=False,separators=(',',':'));out.write('\n')
        os.replace(tmp,file)
    finally:
        if os.path.exists(tmp):os.unlink(tmp)
    print(f"Applied official numeric facts through {result['latestDate']}; semantic changes remain explicit pending items")
if __name__=='__main__':main()
