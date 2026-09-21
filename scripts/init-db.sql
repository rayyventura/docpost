-- Create logical databases
CREATE DATABASE docpost_auth;
CREATE DATABASE docpost_platform;
CREATE DATABASE docpost_api;

-- Create per-service roles with passwords
CREATE ROLE auth_service WITH LOGIN PASSWORD 'auth_local';
CREATE ROLE platform_service WITH LOGIN PASSWORD 'platform_local';
CREATE ROLE docpost_service WITH LOGIN PASSWORD 'docpost_local';

-- Grant ownership
GRANT ALL PRIVILEGES ON DATABASE docpost_auth TO auth_service;
GRANT ALL PRIVILEGES ON DATABASE docpost_platform TO platform_service;
GRANT ALL PRIVILEGES ON DATABASE docpost_api TO docpost_service;

-- Connect to each database and set default privileges
\c docpost_auth
GRANT ALL ON SCHEMA public TO auth_service;
ALTER DEFAULT PRIVILEGES FOR ROLE docpost_admin IN SCHEMA public GRANT ALL ON TABLES TO auth_service;
ALTER DEFAULT PRIVILEGES FOR ROLE docpost_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO auth_service;

\c docpost_platform
GRANT ALL ON SCHEMA public TO platform_service;
ALTER DEFAULT PRIVILEGES FOR ROLE docpost_admin IN SCHEMA public GRANT ALL ON TABLES TO platform_service;
ALTER DEFAULT PRIVILEGES FOR ROLE docpost_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO platform_service;

\c docpost_api
GRANT ALL ON SCHEMA public TO docpost_service;
ALTER DEFAULT PRIVILEGES FOR ROLE docpost_admin IN SCHEMA public GRANT ALL ON TABLES TO docpost_service;
ALTER DEFAULT PRIVILEGES FOR ROLE docpost_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO docpost_service;
