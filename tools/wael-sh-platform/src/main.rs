use anyhow::Result;
use axum::{
    extract::{Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Json},
    routing::get,
    Router,
};
use serde::{Deserialize, Serialize};
use sqlx::postgres::{PgPool, PgPoolOptions};

const ALLOW_ORIGIN: &str = "https://wael.sh";
const DEFAULT_LIMIT: i64 = 20;
const MAX_LIMIT: i64 = 50;

/// One row as it is stored in Postgres, flat like the table itself.
#[derive(sqlx::FromRow)]
struct Row {
    id: String,
    ts: String, // the exact signed string, which is only copied and never parsed
    r#type: String, // `type` is a Rust keyword, and r# allows it to be used as a name
    text: String,
    tags: Vec<String>,
    source_title: Option<String>,
    source_url: Option<String>,
    media_url: Option<String>,
    media_sha256: Option<String>,
    media_alt: Option<String>,
    sig: Option<String>,
    edited_at: Option<String>, // the exact signed string, as with ts; v2 posts only
}

/// One entry as the locked contract serves it, with nested source and media
/// objects and absent keys omitted, exactly as in feed.json.
#[derive(Serialize)]
struct Entry {
    id: String,
    ts: String,
    #[serde(rename = "type")]
    kind: String,
    text: String,
    tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    source: Option<SourceRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    media: Option<MediaRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sig: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    edited_at: Option<String>,
}

#[derive(Serialize)]
struct SourceRef {
    title: String,
    url: String,
}

#[derive(Serialize)]
struct MediaRef {
    url: String,
    sha256: String,
    alt: String,
}

impl From<Row> for Entry {
    fn from(r: Row) -> Entry {
        Entry {
            id: r.id,
            ts: r.ts,
            kind: r.r#type,
            text: r.text,
            tags: r.tags,
            source: match (r.source_title, r.source_url) {
                (Some(title), Some(url)) => Some(SourceRef { title, url }),
                _ => None,
            },
            media: match (r.media_url, r.media_sha256, r.media_alt) {
                (Some(url), Some(sha256), Some(alt)) => Some(MediaRef { url, sha256, alt }),
                _ => None,
            },
            sig: r.sig,
            edited_at: r.edited_at,
        }
    }
}

#[derive(Serialize)]
struct Feed {
    v: i32,
    alg: String,
    pubkey: String,
    generated: String,
    entries: Vec<Entry>,
}

/// Query-string parameters for /api/feed?before=<ts>&limit=<n>. Both are
/// optional. limit arrives as a raw string, and an unparseable value falls back
/// to the default rather than producing a 400. This behavior is inherited from
/// feed_api.py and is part of the contract.
#[derive(Deserialize)]
struct Page {
    before: Option<String>,
    limit: Option<String>,
}

async fn build_feed(pool: &PgPool, page: Page) -> Result<Feed> {
    let limit = page
        .limit
        .as_deref()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(DEFAULT_LIMIT)
        .clamp(1, MAX_LIMIT);

    let (v, alg, pubkey): (i32, String, String) =
        sqlx::query_as("SELECT v, alg, pubkey FROM feed_meta")
            .fetch_one(pool)
            .await?;

    const COLS: &str = "id, ts, type, text, tags, source_title, source_url, \
                        media_url, media_sha256, media_alt, sig, edited_at";
    let rows: Vec<Row> = match &page.before {
        Some(ts) => {
            sqlx::query_as(&format!(
                "SELECT {COLS} FROM entries WHERE ts < $1 ORDER BY ts DESC LIMIT $2"
            ))
            .bind(ts)
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
        None => {
            sqlx::query_as(&format!(
                "SELECT {COLS} FROM entries ORDER BY ts DESC LIMIT $1"
            ))
            .bind(limit)
            .fetch_all(pool)
            .await?
        }
    };

    Ok(Feed {
        v,
        alg,
        pubkey,
        generated: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string(),
        entries: rows.into_iter().map(Entry::from).collect(),
    })
}

fn ok_headers() -> [(header::HeaderName, &'static str); 3] {
    [
        (header::ACCESS_CONTROL_ALLOW_ORIGIN, ALLOW_ORIGIN),
        (header::VARY, "Origin"),
        (header::CACHE_CONTROL, "public, max-age=60"),
    ]
}

/// Errors carry the same CORS headers as successful responses, so that a
/// browser on wael.sh sees a 503 rather than having it masked as a CORS
/// failure.
fn err_headers() -> [(header::HeaderName, &'static str); 3] {
    [
        (header::ACCESS_CONTROL_ALLOW_ORIGIN, ALLOW_ORIGIN),
        (header::VARY, "Origin"),
        (header::CACHE_CONTROL, "no-store"),
    ]
}

async fn feed(State(pool): State<PgPool>, Query(page): Query<Page>) -> impl IntoResponse {
    // A Postgres text value cannot contain a NUL byte, so this is treated as
    // bad input and answered with a 400, rather than letting the bind fail and
    // surfacing a generic 503.
    if page.before.as_deref().is_some_and(|s| s.contains('\0')) {
        return (
            StatusCode::BAD_REQUEST,
            err_headers(),
            Json(serde_json::json!({"error": "invalid before parameter"})),
        )
            .into_response();
    }
    match build_feed(&pool, page).await {
        Ok(feed) => (StatusCode::OK, ok_headers(), Json(feed)).into_response(),
        Err(e) => {
            eprintln!("feed error: {e}");
            (
                StatusCode::SERVICE_UNAVAILABLE,
                err_headers(),
                Json(serde_json::json!({"error": "feed unavailable"})),
            )
                .into_response()
        }
    }
}

async fn not_found() -> impl IntoResponse {
    (
        StatusCode::NOT_FOUND,
        err_headers(),
        Json(serde_json::json!({"error": "not found"})),
    )
}

#[tokio::main]
async fn main() -> Result<()> {
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect("postgres:///waelsocial?host=/var/run/postgresql")
        .await?;

    let app = Router::new()
        .route("/api/feed", get(feed))
        .fallback(not_found)
        .with_state(pool);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:8082").await?;
    println!("wael-sh-platform serving on 127.0.0.1:8082");
    axum::serve(listener, app).await?;
    Ok(())
}
