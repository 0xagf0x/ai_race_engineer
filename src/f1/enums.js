export const TRACKS = {
  0: "Melbourne", 1: "Paul Ricard", 2: "Shanghai", 3: "Bahrain", 4: "Barcelona",
  5: "Monaco", 6: "Montreal", 7: "Silverstone", 8: "Hockenheim", 9: "Hungaroring",
  10: "Spa", 11: "Monza", 12: "Singapore", 13: "Suzuka", 14: "Abu Dhabi",
  15: "COTA", 16: "Interlagos", 17: "Red Bull Ring", 18: "Sochi", 19: "Mexico City",
  20: "Baku", 21: "Bahrain Short", 22: "Silverstone Short", 23: "COTA Short",
  24: "Suzuka Short", 25: "Hanoi", 26: "Zandvoort", 27: "Imola", 28: "Portimao",
  29: "Jeddah", 30: "Miami", 31: "Las Vegas", 32: "Losail",
};

export const SESSION_TYPES = {
  0: "Unknown", 1: "P1", 2: "P2", 3: "P3", 4: "Short Practice", 5: "Q1", 6: "Q2",
  7: "Q3", 8: "Short Quali", 9: "One-Shot Quali", 10: "Sprint Shootout 1",
  11: "Sprint Shootout 2", 12: "Sprint Shootout 3", 13: "Short Sprint Shootout",
  14: "One-Shot Sprint Shootout", 15: "Race", 16: "Race 2", 17: "Race 3", 18: "Time Trial",
};

export const WEATHER = {
  0: "Clear", 1: "Light cloud", 2: "Overcast", 3: "Light rain", 4: "Heavy rain", 5: "Storm",
};

export const VISUAL_TYRES = {
  16: "Soft", 17: "Medium", 18: "Hard", 7: "Inter", 8: "Wet",
};

export const DRIVER_STATUS = {
  0: "In garage", 1: "Flying lap", 2: "In lap", 3: "Out lap", 4: "On track",
};

export const PIT_STATUS = { 0: "", 1: "PIT", 2: "PIT AREA" };

export const TEAMS = {
  0: "Mercedes", 1: "Ferrari", 2: "Red Bull", 3: "Williams", 4: "Aston Martin",
  5: "Alpine", 6: "RB", 7: "Haas", 8: "McLaren", 9: "Sauber",
};

// BUTN event bit flags
export const BUTTONS = {
  CROSS: 0x0001, TRIANGLE: 0x0002, CIRCLE: 0x0004, SQUARE: 0x0008,
  DPAD_LEFT: 0x0010, DPAD_RIGHT: 0x0020, DPAD_UP: 0x0040, DPAD_DOWN: 0x0080,
  OPTIONS: 0x0100, L1: 0x0200, R1: 0x0400, L2: 0x0800, R2: 0x1000,
  L3: 0x2000, R3: 0x4000,
  UDP_ACTION_1: 0x00100000, UDP_ACTION_2: 0x00200000, UDP_ACTION_3: 0x00400000,
};
