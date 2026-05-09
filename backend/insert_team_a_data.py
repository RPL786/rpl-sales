import sqlite3

db_path = r"E:\sales_agent\data\sales_dashboard.db"

conn = sqlite3.connect(db_path)
cur = conn.cursor()

data = [
    ("Team A", "Ali Khan", "Ressi 001", "Product X", 2025, "Jan", 210),
    ("Team A", "Ali Khan", "Ressi 001", "Product X", 2025, "Feb", 180),
    ("Team A", "Saddam", "Ressi 001", "Product X", 2025, "Jan", 150),
    ("Team A", "Ali Khan", "Ressi 001", "Product X", 2026, "Jan", 300),
    ("Team A", "Ali Khan", "Ressi 001", "Product X", 2026, "Feb", 250),
]

cur.executemany("""
INSERT INTO sales_entries (team, sales_person, client_name, product, year, month, quantity)
VALUES (?, ?, ?, ?, ?, ?, ?)
""", data)

conn.commit()
conn.close()

print("✅ Team A test data inserted successfully")