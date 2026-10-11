import assert from 'node:assert/strict';
import test from 'node:test';
import { assessItem } from './classify';

const severityOf = (headline: string, summary = '') => assessItem({ headline, summary }).severity;
const codesOf = (headline: string, summary = '') => assessItem({ headline, summary }).countryCodes;

test('assesses the reports shown in the feed screenshot', () => {
  const riyadh = assessItem({
    headline: 'Several injured in attack on airport in Saudi capital Riyadh',
    summary: 'The US embassy says it is "aware of attacks on King Khalid International Airport", which come days after Yemen\'s Houthis said they had struck it.',
  });
  assert.equal(riyadh.severity, 'High');
  assert.deepEqual(riyadh.countryCodes.slice().sort(), ['SA', 'US', 'YE']);

  const hurricane = assessItem({
    headline: 'Four dead and thousands without power after Hurricane Isaias lashes US',
    summary: 'Roofs were ripped off buildings after Isaias barrelled into the US on Friday evening, before it weakened to a post-tropical cyclone.',
  });
  assert.equal(hurricane.severity, 'Medium');
  assert.equal(hurricane.deaths, 4);
  assert.deepEqual(hurricane.countryCodes, ['US']);

  const trump = assessItem({
    headline: "'Time for Ukraine to get new president,' says Trump after Zelensky condemns diesel deal",
    summary: "Ukraine's leader had said the deal with Russia to release diesel into the US would help Moscow fund the war.",
  });
  assert.equal(trump.severity, 'Low');
  assert.ok(trump.countryCodes.includes('UA') && trump.countryCodes.includes('RU'));

  const earhart = assessItem({
    headline: "Expedition hopes to find aviator Amelia Earhart's plane on remote island",
    summary: 'The team en route to the suspected crash site aim finally to solve the mystery of her 1937 disappearance.',
  });
  assert.equal(earhart.severity, 'Unassessed');
  assert.match(earhart.rationale, /no severity is assigned/i);
});

test('missing information is Unassessed, never Low or Watch', () => {
  assert.equal(severityOf('Council approves new cycle lanes', 'The plan covers three roads.'), 'Unassessed');
  assert.equal(severityOf('', ''), 'Unassessed');
});

test('casualty figures drive impact', () => {
  assert.equal(severityOf('Earthquake kills 250 in Nepal'), 'Critical');
  assert.equal(severityOf('Strike kills 12 in Gaza'), 'High');
  assert.equal(severityOf('Floods kill five in Kenya'), 'Medium');
  assert.equal(severityOf('Dozens killed in attack on market in Sudan'), 'High');
  assert.equal(severityOf('Hundreds killed in massacre in Darfur'), 'Critical');
});

test('mass-atrocity, nuclear and war-declaration language is Critical', () => {
  assert.equal(severityOf('Genocide warning issued for region'), 'Critical');
  assert.equal(severityOf('Drone strike hits nuclear power plant in Ukraine'), 'Critical');
});

test('ongoing multi-country violence can reach Critical', () => {
  const result = assessItem({
    headline: 'Missile attack continues across the region as Iran, Israel and Lebanon exchange strikes',
    summary: 'Dozens were killed overnight.',
  });
  assert.equal(result.severity, 'Critical');
});

test('sport and entertainment uses of ambiguous words are not security events', () => {
  assert.equal(severityOf('Liverpool attack too strong for Chelsea in Premier League clash'), 'Unassessed');
  assert.equal(severityOf('Film about a terror attack tops box office'), 'Unassessed');
  assert.equal(severityOf('Gunmen kill 12 fans outside football stadium in Nigeria'), 'High');
});

test('foiled attacks are reduced one level', () => {
  assert.equal(severityOf('Police foil attack plot in France'), 'Medium');
});

test('hedged reports are flagged', () => {
  assert.equal(assessItem({ headline: 'Unconfirmed reports of explosion in Tehran', summary: '' }).hedged, true);
});

test('country association', () => {
  assert.deepEqual(codesOf('Niger and Nigeria leaders meet in Abuja').sort(), ['NE', 'NG']);
  assert.deepEqual(codesOf('South Sudan troops clash', 'Sudanese army advances').sort(), ['SD', 'SS']);
  assert.deepEqual(codesOf('Aid arrives in Papua New Guinea'), ['PG']);
  assert.deepEqual(codesOf('Navy exercise in the Indian Ocean'), ['UNKNOWN']);
  assert.deepEqual(codesOf('Leaders call for worldwide action'), ['GLOBAL']);
  assert.deepEqual(codesOf('Council approves new cycle lanes'), ['UNKNOWN']);
  assert.deepEqual(codesOf('Floods in Kenya worsen a global hunger crisis').sort(), ['GLOBAL', 'KE']);
  assert.ok(!codesOf('He told us it was fine').includes('US'));
});

test('preparedness and policy talk about pandemics is not an emergency', () => {
  assert.equal(severityOf('World leaders call for worldwide action on pandemic preparedness', 'A summit opens in Geneva.'), 'Unassessed');
  assert.equal(severityOf('WHO declares new pandemic as cases spread across several countries'), 'High');
});

test('classification is deterministic', () => {
  const input = { headline: 'Drone attack on port in Sudan', summary: 'Several injured.' };
  assert.deepEqual(assessItem(input), assessItem(input));
});

test('negated casualty phrases do not count as injuries; strong quakes and hunger crises are assessed', () => {
  const foiled = assessItem({ headline: 'Explosion at nuclear plant in France foiled, officials say', summary: 'No injuries reported.' });
  assert.equal(foiled.injured, null);
  assert.equal(foiled.severity, 'High', 'a foiled incident at a nuclear plant stays High, one level below Critical');
  assert.equal(assessItem({ headline: 'Earthquake of magnitude 7.1 hits Japan, tsunami warning issued', summary: 'Hundreds feared trapped.' }).severity, 'High');
  assert.equal(assessItem({ headline: 'Hunger crisis worsens in Yemen', summary: 'WFP appeals for funds.' }).severity, 'Medium');
});
