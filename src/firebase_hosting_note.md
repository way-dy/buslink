# Firebase Hosting 라우팅 설정 필요

firebase.json 의 hosting rewrites 에 아래 추가:

```json
{
  "hosting": {
    "public": "build",
    "ignore": ["firebase.json", "**/.*", "**/node_modules/**"],
    "rewrites": [
      { "source": "**", "destination": "/index.html" }
    ]
  }
}
```

"**" 와일드카드가 있으면 /board, /bus, /board?t=xxx 모두 index.html 로 라우팅됨.
이미 설정되어 있다면 추가 작업 불필요.
