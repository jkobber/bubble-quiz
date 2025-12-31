This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.

## Docker Deployment

### Prerequisites

- Docker and Docker Compose installed on your machine.

### Running with Pre-built Image (Production)

1.  **Navigate to the docker folder:**

    ```bash
    cd docker
    ```

2.  **Configure Environment:**
    Copy or edit the `prod.env` file. You **MUST** change `AUTH_SECRET` and set `AUTH_URL` for production usage.
    
    ```bash
    # Edit the file
    nano prod.env
    ```

3.  **Run the container:**

    ```bash
    docker compose --env-file prod.env up -d
    ```

    The application will be available at `http://localhost:3000`.
    Data will be persisted in `../data` (relative to the docker folder).

### Building Manually

If you prefer to build from source:

```bash
# From the root directory
docker build -f docker/Dockerfile -t bubble-quiz .
docker run -p 3000:3000 \
  -v $(pwd)/data:/app/data \
  --env-file docker/prod.env \
  bubble-quiz
```

### GitHub Actions

This repository includes a GitHub Workflow that automatically builds and pushes a Docker image to the GitHub Container Registry (GHCR) whenever changes are pushed to the `main` branch. The image is tagged with the version specified in `package.json` and `latest`.

## Testing

The project uses [Vitest](https://vitest.dev/) for unit and integration testing.

### Running Tests

To run the tests once:

```bash
yarn test
```

### Development Mode

To run tests in watch mode during development:

```bash
yarn test:watch
```

### Coverage Report

To generate a coverage report:

```bash
yarn test:coverage
```
