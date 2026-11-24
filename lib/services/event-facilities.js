// lib/services/event-facilities.js - Event Facilities & Amenities Module.
// Configurable predefined & custom amenities for organiser events.

import { db } from '../db.js';

export const FACILITY_CATEGORIES = {
  parking: { label: 'Parking', icon: 'car' },
  food_beverage: { label: 'Food & Beverages', icon: 'utensils' },
  accessibility: { label: 'Accessibility', icon: 'wheelchair' },
  medical_safety: { label: 'Medical & Safety', icon: 'shield-plus' },
  other: { label: 'Other Facilities & Rules', icon: 'info' },
  custom: { label: 'Custom Facilities', icon: 'star' }
};

export const PREDEFINED_FACILITIES = [
  // PARKING
  { category: 'parking', key: 'paid_parking', name: 'Paid parking available', icon: 'parking' },
  { category: 'parking', key: 'free_parking', name: 'Free parking available', icon: 'parking' },
  { category: 'parking', key: 'two_wheeler_parking', name: 'Two-wheeler parking', icon: 'bike' },
  { category: 'parking', key: 'four_wheeler_parking', name: 'Four-wheeler parking', icon: 'car' },
  { category: 'parking', key: 'valet_parking', name: 'Valet parking', icon: 'key' },

  // FOOD & BEVERAGES
  { category: 'food_beverage', key: 'food_available', name: 'Food available', icon: 'utensils' },
  { category: 'food_beverage', key: 'veg_options', name: 'Vegetarian options', icon: 'leaf' },
  { category: 'food_beverage', key: 'non_veg_options', name: 'Non-vegetarian options', icon: 'drumstick' },
  { category: 'food_beverage', key: 'alcohol_available', name: 'Alcohol available (21+ only, legally permitted)', icon: 'glass' },
  { category: 'food_beverage', key: 'non_alcoholic', name: 'Non-alcoholic beverages', icon: 'cup' },
  { category: 'food_beverage', key: 'outside_food_restrictions', name: 'Outside food restrictions', icon: 'ban' },

  // ACCESSIBILITY
  { category: 'accessibility', key: 'wheelchair_accessible', name: 'Wheelchair accessible', icon: 'wheelchair' },
  { category: 'accessibility', key: 'accessible_entrance', name: 'Accessible entrance', icon: 'door-open' },
  { category: 'accessibility', key: 'accessible_washrooms', name: 'Accessible washrooms', icon: 'bath' },
  { category: 'accessibility', key: 'companion_assistance', name: 'Companion assistance', icon: 'hands-helping' },
  { category: 'accessibility', key: 'accessible_parking', name: 'Accessible parking', icon: 'parking-accessible' },

  // MEDICAL & SAFETY
  { category: 'medical_safety', key: 'first_aid', name: 'First-aid support', icon: 'first-aid' },
  { category: 'medical_safety', key: 'medical_staff', name: 'Medical staff on site', icon: 'user-md' },
  { category: 'medical_safety', key: 'ambulance', name: 'Ambulance availability', icon: 'ambulance' },
  { category: 'medical_safety', key: 'security_personnel', name: 'Security personnel', icon: 'shield' },
  { category: 'medical_safety', key: 'emergency_assistance', name: 'Emergency assistance', icon: 'bell' },

  // OTHER
  { category: 'other', key: 'common_washrooms', name: 'Common washrooms', icon: 'restroom' },
  { category: 'other', key: 'smoking_zones', name: 'Designated smoking zones', icon: 'smoking' },
  { category: 'other', key: 'cloakroom', name: 'Cloakroom & baggage storage', icon: 'box' },
  { category: 'other', key: 'photography_rules', name: 'Photography allowed / rules apply', icon: 'camera' },
  { category: 'other', key: 're_entry_policy', name: 'Re-entry policy', icon: 'door' },
  { category: 'other', key: 'age_restrictions', name: 'Age restrictions (21+ only)', icon: 'id-card' },
  { category: 'other', key: 'dress_code', name: 'Dress code applicable', icon: 'tshirt' },
  { category: 'other', key: 'pet_policy', name: 'Pet friendly / Pet restrictions', icon: 'paw' }
];

export async function saveEventFacilities(c, eventId, facilities = []) {
  await c.query(`DELETE FROM event_facilities WHERE event_id = $1`, [eventId]);
  if (!Array.isArray(facilities) || facilities.length === 0) {
    await c.query(`UPDATE events SET has_facilities = false WHERE id = $1`, [eventId]);
    return [];
  }

  const valid = [];
  for (let i = 0; i < facilities.length; i++) {
    const f = facilities[i];
    const name = String(f.name || '').trim();
    if (!name) continue;
    const cat = FACILITY_CATEGORIES[f.category] ? f.category : 'custom';
    const key = String(f.facilityKey || f.key || `custom_${i}`).trim();
    const desc = f.description ? String(f.description).trim().slice(0, 500) : null;
    const icon = f.icon ? String(f.icon).trim().slice(0, 50) : null;
    const isCustom = Boolean(f.isCustom || cat === 'custom');

    const res = await c.query(
      `INSERT INTO event_facilities (event_id, category, facility_key, name, description, icon, is_custom, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [eventId, cat, key, name, desc, icon, isCustom, i]
    );
    valid.push(res.rows[0]);
  }

  await c.query(`UPDATE events SET has_facilities = $2 WHERE id = $1`, [eventId, valid.length > 0]);
  return valid;
}

export async function getEventFacilities(first, second = db) {
  const c = (first && typeof first.query === 'function') ? first : second;
  const eventId = (first && typeof first.query === 'function') ? second : first;

  const { rows } = await c.query(
    `SELECT * FROM event_facilities WHERE event_id = $1 ORDER BY sort_order ASC, created_at ASC`,
    [eventId]
  );
  return rows;
}

export function groupFacilitiesByCategory(facilities = []) {
  const groups = {};
  for (const f of facilities) {
    const cat = f.category || 'other';
    if (!groups[cat]) {
      groups[cat] = {
        category: cat,
        label: FACILITY_CATEGORIES[cat]?.label || 'Other Facilities',
        icon: FACILITY_CATEGORIES[cat]?.icon || 'info',
        items: []
      };
    }
    groups[cat].items.push(f);
  }
  return Object.values(groups);
}
