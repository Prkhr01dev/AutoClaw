import urllib.request
import urllib.parse
import urllib.error
import json
import ssl

# Replace with the corrected API key
API_KEY = ""
HOST = "chatgpt-42.p.rapidapi.com"

url = f"https://{HOST}/conversationgpt4-2"

payload = {
    "messages": [
        {"role": "user", "content": "Hello, who are you and what model are you based on?"}
    ],
    "system_prompt": "",
    "temperature": 0.9,
    "top_k": 5,
    "top_p": 0.9,
    "max_tokens": 256,
    "web_access": False
}

headers = {
    "x-rapidapi-key": API_KEY,
    "x-rapidapi-host": HOST,
    "Content-Type": "application/json",
    "Accept": "application/json"
}

print(f"Testing endpoint: {url}")
try:
    req = urllib.request.Request(url, data=json.dumps(payload).encode('utf-8'), headers=headers, method='POST')
    # Bypass SSL verification if needed for some local environments
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE

    with urllib.request.urlopen(req, context=ctx) as response:
        print(f"Status Code: {response.status}")
        print("Response:")
        data = response.read().decode('utf-8')
        try:
            print(json.dumps(json.loads(data), indent=2))
        except json.JSONDecodeError:
            print(data)
except urllib.error.URLError as e:
    print(f"Error: {e}")
except Exception as e:
    print(f"Unexpected Error: {e}")
