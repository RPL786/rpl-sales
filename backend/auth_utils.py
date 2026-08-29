from dotenv import load_dotenv
import os

load_dotenv()
from passlib.context import CryptContext
from jose import JWTError, jwt
from datetime import datetime, timedelta
import os
import secrets

SECRET_KEY = os.getenv("JWT_SECRET_KEY", "").strip()
if not SECRET_KEY:
    raise RuntimeError("JWT_SECRET_KEY missing. Please set JWT_SECRET_KEY in backend/.env")

if SECRET_KEY == "mysecretkey123" or len(SECRET_KEY) < 32:
    raise RuntimeError("JWT_SECRET_KEY is weak. Please use a long random value in backend/.env")

ALGORITHM = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("ACCESS_TOKEN_EXPIRE_MINUTES", "720"))

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

def hash_password(password: str):
    password = str(password)[:72]
    return pwd_context.hash(password)

def verify_password(plain, hashed):
    plain = str(plain)[:72]
    return pwd_context.verify(plain, hashed)

def create_access_token(data: dict):
    to_encode = data.copy()
    expire = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    to_encode.update({"exp": expire})
    return jwt.encode(to_encode, SECRET_KEY, algorithm=ALGORITHM)