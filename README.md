# 1) Backend

cd server
cp .env.example .env

# paste your OPENAI_API_KEY (and optional GITHUB_TOKEN) into .env

npm i
npm run dev

# 2) Frontend (in a new terminal)

cd ../client
npm i
npm run dev

# Open http://localhost:5173
