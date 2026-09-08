// Units: distances in game units, motion in seconds, timestamps in epoch ms,
// mass/excitation in bytes, luminosity in bytes/day. Constants have one owner.
export const A_BODY = 50, HORIZON_K = 2, A_MAX_SPACE = 150;
export const R_MIN = 12, R_K = 8, R_MAX = 64, ATMOSPHERE = 30;
export const ESCAPE_K = 1.5, TAKEOFF_K = 1.2, H_SPACE_MAX = 45;
export const SLOT_D0 = 220, SPACE_PACK = 4, GROUP_RING_MIN = 60, GROUP_GAP = 40;
export const GOLDEN_ANGLE = 2.39996, PROBE_RANGE_SPACE = 600;
export const SPEED_CRUISE = 45, SPEED_BOOST = 120, DAMPING_FREE = 1.8, DAMPING_BRAKE = 9;
export const THRUST_CRUISE = DAMPING_FREE * SPEED_CRUISE, THRUST_BOOST = DAMPING_FREE * SPEED_BOOST;
export const SHIP_RADIUS = 1.4, OPEN_RANGE = 18, MAX_SPEED = 150, PHYSICS_STEP = 1 / 120;
export const HALF_LIFE_MS = 259200000, GIT_WINDOW_DAYS = 90, BYTES_PER_LINE = 40, RHO_TOUCH = .05;
export const LAMBDA_DAY = Math.LN2 * 86400000 / HALF_LIFE_MS, L_MIN = LAMBDA_DAY * 4096;
export const AMBIENT = .04, ILLUM_GAIN = 2, HEADLAMP_RANGE = 40, FLASH_SECONDS = 2.5;
export const ELEMENT_COLORS = Object.freeze({ source: 0x68e4ef, markup: 0xffad9b, data: 0xc4a5ff, image: 0xf29bd3, media: 0x77b9ff, binary: 0xaab8ff, other: 0xd0d6e6 });
export const G_SURFACE_MAX = 45, A_MOL = 12, A_MAX_SURFACE = 120;
export const EPS_0 = 12, M_REF = 1024, CUTOFF = 3, BUFFET_K = 40, JITTER_K = .5;
export const DAMP_BOND = 3, BOND_DENSITY_RADIUS = 12, BOND_DENSITY_REF = 6, K_EDGE = 2;
export const SURFACE_FLOOR = 2, ATOM_GAP = 1.6, PACK_GAP = 6, PACK_DEPTH = .35, MOL_PADDING = 6;
export const SURFACE_MARGIN = 60, EDGE_MARGIN = 20, MAX_BONDS_PER_ATOM = 3;
export const TAKEOFF_ALTITUDE = 80, TAKEOFF_HOLD = 1, LANDING_SECONDS = 1.5, TAKEOFF_SECONDS = 1.2, TAKEOFF_SPEED = 60;
export const H_SURFACE_MAX = 12, GRID_RESOLUTION = 96;
export const PLANET_SEARCH_DEPTH = 3, MAX_PLANETS = 64, MAX_NESTED_REPOS = 8;
export const DISCOVERY_MS = 2000, DISCOVERY_INTERVAL_MS = 30000, SURVEY_CONCURRENCY = 4;
export const PLANET_SCAN_MS = 1500, SPACE_TICK_BUDGET_MS = 1500, PLANET_CACHE_MS = 60000, PLANET_LOAD_RETRIES = 1;
export const GIT_CACHE_MS = 15000, GIT_BUDGET_MS = 3000, GIT_CONCURRENCY = 2;
