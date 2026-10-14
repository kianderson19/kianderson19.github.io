import importlib.util,json,unittest
from pathlib import Path
from datetime import datetime,timezone
spec=importlib.util.spec_from_file_location('patches',Path(__file__).with_name('refresh-patches.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
NOW=datetime(2026,10,14,4,tzinfo=timezone.utc)
URL='https://overwatch.blizzard.com/en-us/news/patch-notes/live/2026/10/'
class PatchTests(unittest.TestCase):
 def setUp(self):
  self.html=Path(__file__).with_name('fixtures').joinpath('hotfix-2026-10-13.html').read_text()
  self.note=p.parse_notes(self.html,URL)[0]
  self.base={'schemaVersion':1,'baselineDate':'2026-10-13','latestDate':'2026-10-13','detectedAt':NOW.isoformat(),'patches':[self.note]}
 def test_actual_official_hotfix(self):
  self.assertEqual(self.note['date'],'2026-10-13');self.assertEqual(len(self.note['facts']),11);self.assertEqual(self.note['pending'],[])
  self.assertEqual({f['heroId'] for f in self.note['facts']},{'doctrine','sombra','roadhog','kiriko','dmon'})
  self.assertEqual(next(f['to'] for f in self.note['facts'] if f['heroId']=='roadhog' and f['stat']=='cooldown'),1.25)
 def test_unknown_rework_not_applied(self):
  self.assertIn('reason',p.classify('sombra','Hack','Ability removed.'))
  self.assertIn('reason',p.classify(None,None,'Base health increased from 225 to 250.'))
 def test_direction_and_mode(self):
  self.assertIn('reason',p.classify('kiriko',None,'Base health reduced from 225 to 250.'))
  self.assertIsNone(p.classify('kiriko',None,'Base health increased from 225 to 250. (6v6)'))
 def test_html_failure_does_not_overwrite(self):
  before=json.dumps(self.base,sort_keys=True)
  with self.assertRaises(ValueError):p.collect(self.base,NOW,lambda _: '<html>Cloudflare error</html>')
  self.assertEqual(json.dumps(self.base,sort_keys=True),before)
 def test_network_failure_preserves_previous(self):
  before=json.dumps(self.base,sort_keys=True)
  def failed(_):raise TimeoutError('offline')
  with self.assertRaises(TimeoutError):p.collect(self.base,NOW,failed)
  self.assertEqual(json.dumps(self.base,sort_keys=True),before)
 def test_unchanged_has_no_timestamp_churn(self):
  self.assertEqual(p.merge(self.base,[self.note],NOW),self.base)
 def test_month_boundary_keeps_history(self):
  self.assertEqual(p.merge(self.base,[],datetime(2026,11,1,tzinfo=timezone.utc)),self.base)
 def test_rejects_foreign_source(self):
  bad=json.loads(json.dumps(self.base));bad['patches'][0]['sourceUrl']='https://example.com/patch/'
  with self.assertRaises(ValueError):p.validate(bad)
if __name__=='__main__':unittest.main()
