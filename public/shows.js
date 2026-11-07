// Ibilaw 2026 (Halloween at Walibi Belgium, 10 Oct – 11 Nov): shows and Halloween extras with their times.
// Sources, checked 7 Nov 2026: walibi.be/halloween-walibi/nl/show and /bill-procession (show times), ooparc.com
// "Halloween à Walibi Belgium : IBILAW 2026" (haunted house / scare zone hours and places, Tiki Theater, pizza buffet).
// Walibi itself gives no places for the houses and zones; "near" is the ride the guide names. The Tiki Theater (Exotic
// World) isn't in OpenStreetMap: the Tiki-Bar next to it stands in for its position (approx).
// Pure data + helpers (used by the app and by the Worker's notifications).

// days open until 22:00 ("verlengde Halloween dagen"); the other season days close at 18:00
export const EXTENDED = ['2026-10-17', '2026-10-24', '2026-10-25', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-07', '2026-11-11'];
export const SEASON = { from: '2026-10-10', to: '2026-11-11' };

const TIKI = { lat: 50.697, lon: 4.587, approx: true };
const near = (name, lat, lon) => ({ near: name, lat, lon });

// times as 'HH:MM' Brussels; day = a normal Halloween day, ext = an extended day
export const SHOWS = [
  { id: 'bill-show', name: 'Bill: A Fairy Tale', icon: '🎭', kind: 'show', where: 'Tiki Theater (Exotic World)', ...TIKI,
    times: { day: ['13:30', '15:00', '16:30'], ext: ['13:30', '15:00', '16:30', '18:00'] },
    about: 'Gratis show: hoe de jongen achter de spiegel de heerser van Ibilaw werd. Kom op tijd, de zaal loopt snel vol.' },
  { id: 'bill-procession', name: "Bill's procession", icon: '🕯️', kind: 'parade', where: 'door de lanen van het park', roughly: true,
    times: { day: ['17:00'], ext: ['19:00'] },
    about: 'Bij het vallen van de nacht trekt Bill met zijn volgelingen door de lanen. Tijd is "vanaf ongeveer".' },
];

// haunted houses (house), scare zones (zone) and the pizza buffet: open from–to
export const SPOOKY = [
  { id: 'grand-hotel', name: 'The Grand Hotel', icon: '🏨', kind: 'house', where: 'Exotic World', ...near('Tiki-Waka', 50.696948, 4.587079), price: '€ 7,50 · verlengde dag € 8,50', hours: { day: ['13:00', '17:00'], ext: ['12:00', '22:00'] } },
  { id: 'aquarium', name: 'Aquarium', icon: '🐙', kind: 'house', where: 'Dock World', ...near('Mecalodon', 50.69739, 4.589106), price: '€ 6,50 · verlengde dag € 7,50', hours: { day: ['14:00', '17:00'], ext: ['13:00', '22:00'] } },
  { id: 'silence', name: 'Silence', icon: '🤫', kind: 'house', where: 'Karma World', ...near('Cobra', 50.700441, 4.594102), price: '€ 6,50 · verlengde dag € 7,50', hours: { day: ['15:00', '17:00'], ext: ['14:00', '22:00'] } },
  { id: 'mine-blast', name: 'Mine Blast', icon: '💥', kind: 'house', where: 'Adventure World', ...near('Dalton Terror', 50.698754, 4.588001), price: 'gratis', hours: { day: ['16:00', '18:00'], ext: ['16:00', '22:00'] } },
  { id: 'hecatomb', name: 'Hecatomb', icon: '💀', kind: 'zone', where: 'bij Kondaa', ...near('Kondaa', 50.697408, 4.585381), price: 'gratis', hours: { day: ['14:00', '18:00'], ext: ['14:00', '22:00'] } },
  { id: 'innocence', name: 'Innocence', icon: '🧸', kind: 'zone', where: 'Adventure World', ...near('Buzzsaw', 50.699144, 4.588711), price: 'gratis', hours: { day: ['13:00', '18:00'], ext: ['13:00', '22:00'] } },
  { id: 'arachnophobia', name: 'Arachnophobia', icon: '🕷️', kind: 'zone', where: 'Adventure World', ...near('Silverton', 50.699714, 4.589814), price: 'gratis', hours: { day: ['14:30', '18:00'], ext: ['15:00', '22:00'] } },
  { id: 'psycho-circus', name: 'Psycho Circus: The Final Act', icon: '🤡', kind: 'zone', where: 'plek niet vermeld', price: 'gratis', hours: { day: ['10:30', '18:00'], ext: ['10:30', '22:00'] } },
  { id: 'freaky-pizza', name: 'Freaky Pizza Festival', icon: '🍕', kind: 'food', where: 'tegenover de 4D-bioscoop', ...near('4D Wanted Alive', 50.700219, 4.590535), price: 'buffet vanaf € 16,90, clowns aan tafel', hours: { ext: ['11:30', '21:30'] } },
];
export const ADVICE = 'Spookhuizen zijn afgeraden onder 16 jaar. De scare zones komen pas echt tot leven bij donker. Kinderen onder 12 krijgen gratis een anti-monsterbadge aan de Info-balie.';

const mins = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
// 'day' | 'ext' | null (not an Ibilaw day) for a date 'YYYY-MM-DD'
export function dayKind(date) {
  if (!date || date < SEASON.from || date > SEASON.to) return null;
  return EXTENDED.includes(date) ? 'ext' : 'day';
}
// today's shows as [{ ...show, min (minutes since midnight), hm }], sorted by time
export function showsOn(date) {
  const k = dayKind(date); if (!k) return [];
  return SHOWS.flatMap((s) => (s.times[k] || []).map((hm) => ({ ...s, hm, min: mins(hm), key: `${s.id}@${hm}` }))).sort((a, b) => a.min - b.min);
}
// today's houses/zones with from/to minutes (only the ones open that day)
export function spookyOn(date) {
  const k = dayKind(date); if (!k) return [];
  return SPOOKY.filter((s) => s.hours[k]).map((s) => ({ ...s, from: mins(s.hours[k][0]), to: mins(s.hours[k][1]), fromHm: s.hours[k][0], toHm: s.hours[k][1] }));
}
// the next show that hasn't started more than `grace` minutes ago
export function nextShow(date, nowMin, grace = 0) {
  return showsOn(date).find((s) => s.min >= nowMin - grace) || null;
}
