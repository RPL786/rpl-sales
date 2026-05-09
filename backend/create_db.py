import sqlite3
import psycopg2
import os
from pathlib import Path
from dotenv import load_dotenv

load_dotenv()

from pathlib import Path
BASE_DIR = Path(r"E:\sales_agent")
DATA_DIR = BASE_DIR / "data"
DATA_DIR.mkdir(exist_ok=True)

DB_FILE_PATH = DATA_DIR / "sales_dashboard.db"

if os.getenv("DB_ENGINE") == "postgres":
    conn = psycopg2.connect(
        host=os.getenv("POSTGRES_HOST"),
        port=os.getenv("POSTGRES_PORT"),
        database=os.getenv("POSTGRES_DB"),
        user=os.getenv("POSTGRES_USER"),
        password=os.getenv("POSTGRES_PASSWORD"),
    )
else:
    conn = sqlite3.connect(DB_FILE_PATH)

cursor = conn.cursor()

cursor.execute("""
CREATE TABLE IF NOT EXISTS sales_entries (
    id SERIAL PRIMARY KEY,
    team TEXT,
    sales_person TEXT,
    client_name TEXT,
    product TEXT,
    year INTEGER,
    month TEXT,
    quantity REAL
)
""")

conn.commit()
conn.close()

print("✅ Database created successfully")