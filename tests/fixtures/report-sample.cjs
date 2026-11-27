/* Made-up month of data for the v2.7.0 monthly report tests (no real project, person or lift). */
const teams = [['commissioning', 'Commissioning Team'], ['aftersales', 'After Sales Team'], ['production', 'Production Team'], ['maintenance', 'Factory Maintenance Team'], ['qc', 'QC Team'], ['installation', 'Installation Team']]
  .map(([id, name]) => ({id, name}));
const schema = {fields: [{id: 'project', label: 'Project Name'}, {id: 'lift', label: 'Lift ID'}, {id: 'problem_category', label: 'Problem Category'},
  {id: 'nice_error', label: 'NICE3000+ Error Code'}, {id: 'problem', label: 'Problem'}]};
const at = (d, h = 10) => new Date(Date.UTC(2026, 10, d, h - 6)).toISOString();
let n = 0;
const req = (team, d, status, problem, lift, err, who) => ({reference: 'TS-' + (1000 + ++n), at: at(d), team, status, requester: who, requesterSection: '',
  assignee: 'R&I One (101)', solver: status === 'Solved' ? 'R&I One (101)' : '', solvedAt: status === 'Solved' ? at(d, 15) : null, solution: status === 'Solved' ? 'Parameter corrected and tested.' : '',
  values: {project: 'Sample Tower ' + lift, lift, problem_category: problem, nice_error: err, problem: 'Lift stops between floors after a few trips during the evening load.'}, schema, forwards: status === 'Forwarded' ? 1 : 0});
const support = {kind: 'support', month: '2026-11', teams, given: [
  {name: 'R&I One (101)', received: 9, solved: 7, notSolved: 1, forwarded: 1}, {name: 'R&I Two (102)', received: 4, solved: 3, notSolved: 0, forwarded: 1}],
records: [
  req('aftersales', 2, 'Solved', 'NICE3000+ drive error', '5001', 'Err38', 'Field User A (201)'), req('aftersales', 5, 'Solved', 'NICE3000+ drive error', '5001', 'Err38', 'Field User A (201)'),
  req('aftersales', 9, 'Not Solved', 'Door problem', '5002', '', 'Field User B (202)'), req('aftersales', 11, 'Forwarded', 'NICE3000+ drive error', '5003', 'Err20, Err38', 'Field User A (201)'),
  req('commissioning', 3, 'Solved', 'Electrical', '6001', '', 'Commissioning C (301)'), req('commissioning', 12, 'Pending', 'MOTCUBE drive error', '6002', 'H12', 'Commissioning C (301)'),
  req('installation', 20, 'Solved', 'Electrical', '7001', '', 'Installer D (401)'), req('production', 21, 'Received', 'Mechanical', '', '', 'Production E (501)')]};
const actSchema = {fields: [{id: 'subject', label: 'Subject'}, {id: 'status', label: 'Status'}, {id: 'duration_minute', label: 'Duration (minute)'}]};
const act = (sector, form, member, status, minutes, d, subject) => ({at: at(d), sector, form, status, member, minutes, values: {subject, status, duration_minute: String(minutes)}, schema: actSchema});
const activity = {kind: 'activity', month: '2026-11', records: [
  act('team', 'Drawing review', 'R&I One (101)', 'Completed', 90, 2, 'Control panel drawing for a 13-stop lift'), act('team', 'Drawing review', 'R&I Two (102)', 'Ongoing', 60, 4, 'Wiring diagram update'),
  act('team', 'Site visit', 'R&I One (101)', 'Completed', 240, 6, 'Commissioning check'), act('scm', 'Supplier meeting', 'R&I One (101)', 'Completed', 45, 8, 'Brake resistor lead time'),
  act('reports', 'Monthly report', 'R&I Two (102)', 'Completed', 120, 28, 'October technical report'), act('sales', 'Customer layout', 'R&I Two (102)', 'Incomplete', 30, 15, 'Layout for a 630 kg lift')]};
const dd = (team, d, requester, item, model, brand, q, problems, ctl, received) => ({reference: 'DD-' + (++n), at: at(d), team, requester, project: 'Sample Tower', liftId: String(5000 + n), controllers: [ctl],
  problems, item, spec: '', model, brand, supplier: 'Sample Supplier', quantity: q, confirmedBy: 'R&I One (101)', received, claimed: false});
const damage = {kind: 'damage', month: '2026-11', teams: teams.filter(t => ['commissioning', 'aftersales', 'installation', 'maintenance'].includes(t.id)), records: [
  dd('aftersales', 3, 'Field User A (201)', 'Brake resistor', '80 ohm 2.5 kW', 'Sample', 2, ['NICE3000+ drive error'], 'NICE3000+', true),
  dd('aftersales', 7, 'Field User A (201)', 'Brake resistor', '80 ohm 2.5 kW', 'Sample', 1, ['NICE3000+ drive error'], 'NICE3000+', false),
  dd('commissioning', 9, 'Commissioning C (301)', 'Door operator board', 'DB-1', 'Sample', 1, ['Door problem'], 'MOT', true),
  dd('installation', 18, 'Installer D (401)', 'Encoder cable', '10 m', '', 3, ['Electrical'], 'NICE3000+', false)]};
module.exports = {support, activity, damage};
