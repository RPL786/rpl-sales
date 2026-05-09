import sqlite3
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent / "data"
DATA_DIR.mkdir(exist_ok=True)

DB_FILE_PATH = DATA_DIR / "sales_dashboard.db"

conn = sqlite3.connect(DB_FILE_PATH)
cursor = conn.cursor()

# master tables
cursor.execute("""
CREATE TABLE IF NOT EXISTS teams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
)
""")

cursor.execute("""
CREATE TABLE IF NOT EXISTS sales_people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
)
""")

cursor.execute("""
CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
)
""")

cursor.execute("""
CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
)
""")

# main transactional table
cursor.execute("""
CREATE TABLE IF NOT EXISTS sales_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    team TEXT NOT NULL,
    sales_person TEXT NOT NULL,
    client_name TEXT NOT NULL,
    product TEXT NOT NULL,
    year INTEGER NOT NULL,
    month TEXT NOT NULL,
    quantity REAL NOT NULL,
    entry_date TEXT
)
""")

# add entry_date if old table already exists without it
cursor.execute("PRAGMA table_info(sales_entries)")
cols = [row[1] for row in cursor.fetchall()]
if "entry_date" not in cols:
    cursor.execute("ALTER TABLE sales_entries ADD COLUMN entry_date TEXT")

conn.commit()
conn.close()

print("✅ Database schema ready")