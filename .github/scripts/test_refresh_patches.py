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
  self.bugfix=Path(__file__).with_name('fixtures').joinpath('bugfix-2026-10-20.html').read_text()
  self.note=p.parse_notes(self.html,URL)[0]
  self.base={'schemaVersion':1,'baselineDate':'2026-10-13','latestDate':'2026-10-13','detectedAt':NOW.isoformat(),'patches':[self.note]}
 def test_actual_official_hotfix(self):
  self.assertEqual(self.note['date'],'2026-10-13');self.assertEqual(len(self.note['facts']),11);self.assertEqual(self.note['pending'],[])
  self.assertEqual({f['heroId'] for f in self.note['facts']},{'doctrine','sombra','roadhog','kiriko','dmon'})
  self.assertEqual(next(f['to'] for f in self.note['facts'] if f['heroId']=='roadhog' and f['stat']=='cooldown'),1.25)
 def test_reviewed_official_bugfix_has_no_balance_facts(self):
  note=p.parse_notes(self.bugfix,URL)[0]
  self.assertEqual(note['date'],'2026-10-20');self.assertEqual(note['facts'],[]);self.assertEqual(note['pending'],[])
  self.assertEqual(note['sourceSHA256'],'803192629cab3f7d4132f22f1d6d807e644af030dfed8a738b258602e8e2d765')
  self.assertEqual(note['review'],{'kind':'non-balance','summary':'도전 과제와 PC 컨트롤러 오류 수정. 영웅 수치·상성 변경 없음.'})
 def test_review_requires_exact_date_and_text(self):
  edits=[self.bugfix.replace('patch-2026-10-20','patch-2026-10-21'),self.bugfix.replace('Replay codes have been wiped.','Replay codes remain available.'),self.bugfix.replace('Fixed a bug where DualSense controllers were not working properly on PC.','Sombra can now heal allies through enemy barriers.')]
  for html in edits:
   with self.subTest(html=html):
    note=p.parse_notes(html,URL)[0]
    self.assertEqual(note['facts'],[]);self.assertTrue(note['pending']);self.assertNotIn('review',note)
 def test_unknown_generic_paragraph_and_list_require_review(self):
  for body in ['<p>Heroes now respawn immediately.</p>','<ul><li>Removed a hero ability.</li></ul>']:
   with self.subTest(body=body):
    html=f'<div class="PatchNotes-patch"><div id="patch-2026-10-21"></div><div class="PatchNotes-section PatchNotes-section-generic_update"><h4 class="PatchNotes-sectionTitle">General Updates</h4><div class="PatchNotes-sectionDescription">{body}</div></div></div>'
    note=p.parse_notes(html,URL)[0]
    self.assertEqual(note['facts'],[]);self.assertTrue(note['pending']);self.assertNotIn('review',note)
 def test_unrecognized_future_note_requires_review(self):
  for body in ['', '<p>Heroes now respawn immediately.</p>', '<div class="PatchNotes-section PatchNotes-section-hero_update"><p>Abilities are now disabled.</p></div>']:
   with self.subTest(body=body):
    html=f'<div class="PatchNotes-patch"><div id="patch-2026-10-21"></div>{body}</div>'
    note=p.parse_notes(html,URL)[0]
    self.assertEqual(note['facts'],[]);self.assertTrue(note['pending']);self.assertNotIn('review',note)
 def test_mode_excluded_hero_changes_do_not_gain_generic_pending(self):
  html='<div class="PatchNotes-patch"><div id="patch-2026-10-21"></div><div class="PatchNotes-section PatchNotes-section-hero_update"><div class="PatchNotesHeroUpdate"><h5 class="PatchNotesHeroUpdate-name">Kiriko</h5><div class="PatchNotesHeroUpdate-generalUpdates"><ul><li>Base health increased from 225 to 250. (6v6)</li></ul></div></div></div></div>'
  note=p.parse_notes(html,URL)[0]
  self.assertEqual(note['facts'],[]);self.assertEqual(note['pending'],[]);self.assertNotIn('review',note)
 def test_edited_transport_banner_does_not_hide_gameplay(self):
  for body in ['<p>Heroes now respawn immediately.</p>','<ul><li>Removed a hero ability.</li></ul>']:
   with self.subTest(body=body):
    html=self.html.replace('patch are still available.</p>','patch are still available.</p>'+body)
    self.assertNotEqual(html,self.html)
    note=p.parse_notes(html,URL)[0]
    self.assertEqual(len(note['facts']),11);self.assertTrue(note['pending'])
 def test_native_bugfix_flag_is_not_cleared_by_text_acknowledgment(self):
  html=self.bugfix.replace('PatchNotes-section-generic_update','PatchNotes-section-bug_fix',1)
  note=p.parse_notes(html,URL)[0]
  self.assertEqual(note['sourceSHA256'],'803192629cab3f7d4132f22f1d6d807e644af030dfed8a738b258602e8e2d765')
  self.assertTrue(note['pending']);self.assertNotIn('review',note)
 def test_unknown_native_bugfix_requires_review(self):
  html=self.bugfix.replace('patch-2026-10-20','patch-2026-10-21').replace('PatchNotes-section-generic_update','PatchNotes-section-bug_fix')
  note=p.parse_notes(html,URL)[0]
  self.assertTrue(note['pending']);self.assertNotIn('review',note)
 def test_bugfix_merge_advances_date_without_changing_facts_or_churning(self):
  note=p.parse_notes(self.bugfix,URL)[0];now=datetime(2026,10,21,tzinfo=timezone.utc)
  result=p.merge(self.base,[note],now)
  self.assertEqual(result['latestDate'],'2026-10-20');self.assertEqual(result['patches'][0],self.note)
  self.assertEqual(result['patches'][1],note)
  self.assertEqual(p.merge(result,[note],datetime(2026,10,22,tzinfo=timezone.utc)),result)
 def test_rejects_unverified_review_metadata(self):
  note=p.parse_notes(self.bugfix,URL)[0]
  snapshot=p.merge(self.base,[note],datetime(2026,10,21,tzinfo=timezone.utc))
  for field,value in [('sourceSHA256','0'*64),('review',{'kind':'non-balance','summary':'unreviewed'}),('pending',[{'heroId':None,'ability':None,'reason':'unknown gameplay'}])]:
   with self.subTest(field=field):
    bad=json.loads(json.dumps(snapshot));bad['patches'][-1][field]=value
    with self.assertRaises(ValueError):p.validate(bad)
 def test_official_accented_hero_names(self):
  self.assertEqual(p.HERO_ALIASES.get(p.normalize('Lúcio')),'lucio')
  self.assertEqual(p.HERO_ALIASES.get(p.normalize('Torbjörn')),'torbjorn')
  self.assertEqual(p.HERO_ALIASES.get(p.normalize('D.Va')),'dva')
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
