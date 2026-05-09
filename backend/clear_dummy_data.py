import sqlite3

db_path = r"E:\sales_agent\data\sales_dashboard.db"

conn = sqlite3.connect(db_path)
cur = conn.cursor()

cur.execute("DELETE FROM sales_entries")
cur.execute("DELETE FROM teams")
cur.execute("DELETE FROM sales_people")
cur.execute("DELETE FROM clients")
cur.execute("DELETE FROM products")

conn.commit()
conn.close()

print("✅ All database data cleared")