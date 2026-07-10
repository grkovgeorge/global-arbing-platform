# Arbing App Part 2

A starter sportsbook arbitrage web app with:

- React/Vite frontend
- FastAPI Python backend
- Two-way arbitrage calculator
- Sample opportunity feed
- Bankroll and stake allocation

## 1. Install Python

Download Python 3.11 or newer from python.org. During installation, check **Add Python to PATH**.

## 2. Install Node.js

Download the current LTS version from nodejs.org.

## 3. Start the backend

Open Command Prompt in the `backend` folder and run:

```bash
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload
```

The backend will run at http://localhost:8000.

## 4. Start the frontend

Open a second Command Prompt in the `frontend` folder and run:

```bash
npm install
npm run dev
```

Open the local address shown in the terminal, normally http://localhost:5173.

## Current limitation

The opportunity list uses demo odds. The next development step is connecting a legal odds-data API instead of scraping sportsbook websites.
