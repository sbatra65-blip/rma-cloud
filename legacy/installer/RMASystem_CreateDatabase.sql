/*
================================================================================
 RMA System — full database setup script
================================================================================
 Run this on the NEW PC in SQL Server Management Studio (SSMS) or sqlcmd.

 Prerequisites:
   1. SQL Server Express is installed (instance usually .\SQLEXPRESS)
   2. Connect as Windows Admin / sa

 How to run in SSMS:
   1. Open SSMS → Connect to: .\SQLEXPRESS
   2. File → Open → this file
   3. Click Execute (F5)
   4. Confirm messages end with no errors
   5. Restart the RMA System Windows service (or reboot), then open the app

 How to run with sqlcmd (as Administrator):
   sqlcmd -S .\SQLEXPRESS -E -i "C:\Program Files\RMA System\RMASystem_CreateDatabase.sql"

 Connection string the app uses:
   Server=.\SQLEXPRESS;Database=RMASystem;Integrated Security=True;TrustServerCertificate=True;Encrypt=False;

 Safe to re-run: script is idempotent (skips objects/migrations already applied).
================================================================================
*/

IF DB_ID(N'RMASystem') IS NULL
BEGIN
    CREATE DATABASE [RMASystem];
END
GO

USE [RMASystem];
GO
IF OBJECT_ID(N'[__EFMigrationsHistory]') IS NULL
BEGIN
    CREATE TABLE [__EFMigrationsHistory] (
        [MigrationId] nvarchar(150) NOT NULL,
        [ProductVersion] nvarchar(32) NOT NULL,
        CONSTRAINT [PK___EFMigrationsHistory] PRIMARY KEY ([MigrationId])
    );
END;
GO

BEGIN TRANSACTION;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260718062016_InitialCreate'
)
BEGIN
    CREATE TABLE [AppSettings] (
        [Key] nvarchar(100) NOT NULL,
        [Value] nvarchar(max) NOT NULL,
        CONSTRAINT [PK_AppSettings] PRIMARY KEY ([Key])
    );
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260718062016_InitialCreate'
)
BEGIN
    CREATE TABLE [ImportLogs] (
        [Id] int NOT NULL IDENTITY,
        [ImportedAt] datetime NOT NULL,
        [Filename] nvarchar(255) NULL,
        [TotalRows] int NOT NULL,
        [ImportedCount] int NOT NULL,
        [DuplicateCount] int NOT NULL,
        [ErrorCount] int NOT NULL,
        [SummaryText] nvarchar(max) NULL,
        CONSTRAINT [PK_ImportLogs] PRIMARY KEY ([Id])
    );
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260718062016_InitialCreate'
)
BEGIN
    CREATE TABLE [MonthlyBatches] (
        [Id] int NOT NULL IDENTITY,
        [BatchId] nvarchar(30) NOT NULL,
        [BatchMonth] nvarchar(7) NOT NULL,
        [CreatedAt] datetime NOT NULL,
        [DispatchDate] date NULL,
        [TotalRmas] int NOT NULL,
        [Remarks] nvarchar(max) NULL,
        [ExcelPath] nvarchar(max) NULL,
        CONSTRAINT [PK_MonthlyBatches] PRIMARY KEY ([Id])
    );
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260718062016_InitialCreate'
)
BEGIN
    CREATE TABLE [RMATickets] (
        [Id] int NOT NULL IDENTITY,
        [InternalTicketNo] nvarchar(30) NOT NULL,
        [Status] nvarchar(40) NOT NULL,
        [IsImported] bit NOT NULL,
        [CreatedAt] datetime NOT NULL,
        [UpdatedAt] datetime NOT NULL,
        [CustomerCompany] nvarchar(200) NULL,
        [CustomerAddress] nvarchar(max) NULL,
        [CustomerCity] nvarchar(100) NULL,
        [CustomerPostal] nvarchar(20) NULL,
        [CustomerCountry] nvarchar(100) NULL,
        [CustomerContactName] nvarchar(150) NULL,
        [CustomerEmail] nvarchar(200) NULL,
        [CustomerPhone] nvarchar(50) NULL,
        [PoNumber] nvarchar(100) NULL,
        [ShipToCompany] nvarchar(200) NULL,
        [ShipToAddress] nvarchar(max) NULL,
        [ShipToContactName] nvarchar(150) NULL,
        [ShipToEmail] nvarchar(200) NULL,
        [ShipToPhone] nvarchar(50) NULL,
        [PrinterModel] nvarchar(100) NULL,
        [PrinterSn] nvarchar(100) NULL,
        [FaultyPart] nvarchar(200) NULL,
        [FaultyPartSn] nvarchar(100) NULL,
        [FaultyPartNo] nvarchar(100) NULL,
        [FailureDescription] nvarchar(max) NULL,
        [TphMileage] decimal(10,2) NULL,
        [PrinterMileage] decimal(10,2) NULL,
        [FwVersion] nvarchar(50) NULL,
        [FlashInitialized] nvarchar(20) NULL,
        [PurchaseDate] date NULL,
        [DeliveryToUserDate] date NULL,
        [OemRmaNumber] nvarchar(100) NULL,
        [OemRmaAssignDate] date NULL,
        [OemEmailReceivedAt] datetime NULL,
        [OemDispatchDate] date NULL,
        [BatchDispatchId] nvarchar(30) NULL,
        [ZohoChallanId] nvarchar(100) NULL,
        [ZohoChallanNumber] nvarchar(100) NULL,
        [ChallanCreatedAt] datetime NULL,
        [DispatchToCustomerDate] date NULL,
        [ClosedAt] datetime NULL,
        [ClosureType] nvarchar(30) NULL,
        [ClosureRemarks] nvarchar(max) NULL,
        [ExcelFilePath] nvarchar(max) NULL,
        CONSTRAINT [PK_RMATickets] PRIMARY KEY ([Id])
    );
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260718062016_InitialCreate'
)
BEGIN
    CREATE TABLE [RMAPhotos] (
        [Id] int NOT NULL IDENTITY,
        [RmaTicketId] int NOT NULL,
        [Direction] nvarchar(10) NOT NULL,
        [Filename] nvarchar(255) NOT NULL,
        [FilePath] nvarchar(max) NOT NULL,
        [CapturedAt] datetime NOT NULL,
        [CapturedBy] nvarchar(100) NULL,
        [Notes] nvarchar(max) NULL,
        [EmbeddedInExcel] bit NOT NULL,
        CONSTRAINT [PK_RMAPhotos] PRIMARY KEY ([Id]),
        CONSTRAINT [FK_RMAPhotos_RMATickets_RmaTicketId] FOREIGN KEY ([RmaTicketId]) REFERENCES [RMATickets] ([Id]) ON DELETE CASCADE
    );
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260718062016_InitialCreate'
)
BEGIN
    IF EXISTS (SELECT * FROM [sys].[identity_columns] WHERE [name] IN (N'Key', N'Value') AND [object_id] = OBJECT_ID(N'[AppSettings]'))
        SET IDENTITY_INSERT [AppSettings] ON;
    EXEC(N'INSERT INTO [AppSettings] ([Key], [Value])
    VALUES (N''base_dir'', N''C:\Sanjay Projects\Projects\RMA Windows''),
    (N''company_address'', N''312, VISHWADEEP TOWER''),
    (N''company_city'', N''New Delhi''),
    (N''company_contact'', N''Sanjay Batra''),
    (N''company_country'', N''INDIA''),
    (N''company_email'', N''sanjay@infinitesolutions.co.in''),
    (N''company_name'', N''INFINITE SOLUTIONS''),
    (N''company_phone'', N''9311011467''),
    (N''company_postal'', N''110058''),
    (N''oem_address'', N''No. 285, Shulin Dist., New Taipei City 23860, Taiwan''),
    (N''oem_email'', N''tsc_rma@tscprinters.com''),
    (N''oem_fax'', N''+886-2-2267-5581''),
    (N''oem_name'', N''TSC Auto ID Technology Co., Ltd.''),
    (N''oem_phone'', N''+886-2-2267-6000''),
    (N''setup_complete'', N''false''),
    (N''ticket_prefix'', N''INF''),
    (N''zoho_books_org_id'', N''''),
    (N''zoho_books_refresh_token'', N''''),
    (N''zoho_client_id'', N''''),
    (N''zoho_client_secret'', N''''),
    (N''zoho_mail_refresh_token'', N''''),
    (N''zoho_poll_interval_mins'', N''30'')');
    IF EXISTS (SELECT * FROM [sys].[identity_columns] WHERE [name] IN (N'Key', N'Value') AND [object_id] = OBJECT_ID(N'[AppSettings]'))
        SET IDENTITY_INSERT [AppSettings] OFF;
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260718062016_InitialCreate'
)
BEGIN
    CREATE UNIQUE INDEX [IX_MonthlyBatches_BatchId] ON [MonthlyBatches] ([BatchId]);
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260718062016_InitialCreate'
)
BEGIN
    CREATE INDEX [IX_RMAPhotos_RmaTicketId] ON [RMAPhotos] ([RmaTicketId]);
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260718062016_InitialCreate'
)
BEGIN
    CREATE UNIQUE INDEX [IX_RMATickets_InternalTicketNo] ON [RMATickets] ([InternalTicketNo]);
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260718062016_InitialCreate'
)
BEGIN
    INSERT INTO [__EFMigrationsHistory] ([MigrationId], [ProductVersion])
    VALUES (N'20260718062016_InitialCreate', N'8.0.4');
END;
GO

COMMIT;
GO

BEGIN TRANSACTION;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725094532_AddCarePackTables'
)
BEGIN
    CREATE TABLE [CarePackBatches] (
        [Id] int NOT NULL IDENTITY,
        [InvoiceNumber] nvarchar(50) NOT NULL,
        [ZohoInvoiceId] nvarchar(50) NULL,
        [CustomerName] nvarchar(200) NULL,
        [CustomerCity] nvarchar(200) NULL,
        [InvoiceDate] date NULL,
        [Irn] nvarchar(128) NULL,
        [IrnAckNo] nvarchar(50) NULL,
        [IrnAckDate] datetime NULL,
        [OemBrand] nvarchar(50) NULL,
        [CarePackType] nvarchar(50) NULL,
        [PrinterModel] nvarchar(100) NULL,
        [InvoiceItemName] nvarchar(200) NULL,
        [InvoiceDescriptionRaw] nvarchar(max) NULL,
        [InvoiceBrandDetected] nvarchar(50) NULL,
        [InvoiceQty] int NOT NULL,
        [DeviceCount] int NOT NULL,
        [Status] nvarchar(30) NOT NULL,
        [PurchaseOrderNumber] nvarchar(50) NULL,
        [ZohoPurchaseOrderId] nvarchar(50) NULL,
        [PoValidatedAt] datetime NULL,
        [PoValidatedBy] nvarchar(100) NULL,
        [PoMatched] bit NOT NULL,
        [PoValidationNotes] nvarchar(max) NULL,
        [OemInvoiceNumber] nvarchar(100) NULL,
        [OemInvoiceDate] date NULL,
        [InstallationDate] date NULL,
        [ValidationReportPath] nvarchar(max) NULL,
        [Overridden] bit NOT NULL,
        [CreatedAt] datetime NOT NULL,
        [CreatedBy] nvarchar(100) NULL,
        CONSTRAINT [PK_CarePackBatches] PRIMARY KEY ([Id])
    );
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725094532_AddCarePackTables'
)
BEGIN
    CREATE TABLE [CarePackDevices] (
        [Id] int NOT NULL IDENTITY,
        [CarePackBatchId] int NOT NULL,
        [SerialNumber] nvarchar(40) NOT NULL,
        [OemBrand] nvarchar(50) NULL,
        [CarePackType] nvarchar(50) NULL,
        [OriginalModel] nvarchar(100) NULL,
        [WarrantyEnd] date NULL,
        [InvoiceItemName] nvarchar(200) NULL,
        [InvoiceBrandDetected] nvarchar(50) NULL,
        [InvoiceDescriptionRaw] nvarchar(max) NULL,
        [Irn] nvarchar(128) NULL,
        [IrnAckNo] nvarchar(50) NULL,
        [IrnAckDate] datetime NULL,
        [Overridden] bit NOT NULL,
        [OverrideBy] nvarchar(100) NULL,
        [OverrideAt] datetime NULL,
        [OverrideReason] nvarchar(max) NULL,
        [OverrideConfirmed] bit NOT NULL,
        [CreatedAt] datetime NOT NULL,
        CONSTRAINT [PK_CarePackDevices] PRIMARY KEY ([Id]),
        CONSTRAINT [FK_CarePackDevices_CarePackBatches_CarePackBatchId] FOREIGN KEY ([CarePackBatchId]) REFERENCES [CarePackBatches] ([Id]) ON DELETE CASCADE
    );
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725094532_AddCarePackTables'
)
BEGIN
    CREATE UNIQUE INDEX [IX_CarePackBatches_InvoiceNumber] ON [CarePackBatches] ([InvoiceNumber]);
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725094532_AddCarePackTables'
)
BEGIN
    CREATE INDEX [IX_CarePackDevices_CarePackBatchId] ON [CarePackDevices] ([CarePackBatchId]);
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725094532_AddCarePackTables'
)
BEGIN
    CREATE INDEX [IX_CarePackDevices_SerialNumber] ON [CarePackDevices] ([SerialNumber]);
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725094532_AddCarePackTables'
)
BEGIN
    INSERT INTO [__EFMigrationsHistory] ([MigrationId], [ProductVersion])
    VALUES (N'20260725094532_AddCarePackTables', N'8.0.4');
END;
GO

COMMIT;
GO

BEGIN TRANSACTION;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725100454_AddDashboardTables'
)
BEGIN
    CREATE TABLE [ActivityLogs] (
        [Id] int NOT NULL IDENTITY,
        [Category] nvarchar(40) NOT NULL,
        [Title] nvarchar(200) NOT NULL,
        [Detail] nvarchar(300) NULL,
        [Color] nvarchar(20) NOT NULL,
        [RefLink] nvarchar(100) NULL,
        [CreatedAt] datetime NOT NULL,
        CONSTRAINT [PK_ActivityLogs] PRIMARY KEY ([Id])
    );
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725100454_AddDashboardTables'
)
BEGIN
    CREATE TABLE [OemNotifications] (
        [Id] int NOT NULL IDENTITY,
        [Kind] nvarchar(40) NOT NULL,
        [Title] nvarchar(200) NOT NULL,
        [SerialNumber] nvarchar(40) NULL,
        [RefNumber] nvarchar(40) NULL,
        [Status] nvarchar(20) NOT NULL,
        [CreatedAt] datetime NOT NULL,
        [SentAt] datetime NULL,
        CONSTRAINT [PK_OemNotifications] PRIMARY KEY ([Id])
    );
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725100454_AddDashboardTables'
)
BEGIN
    CREATE TABLE [PartMovements] (
        [Id] int NOT NULL IDENTITY,
        [Direction] nvarchar(10) NOT NULL,
        [Description] nvarchar(200) NOT NULL,
        [SerialNumber] nvarchar(40) NULL,
        [PartName] nvarchar(100) NULL,
        [RefNumber] nvarchar(40) NULL,
        [MovedAt] datetime NOT NULL,
        CONSTRAINT [PK_PartMovements] PRIMARY KEY ([Id])
    );
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725100454_AddDashboardTables'
)
BEGIN
    CREATE TABLE [RepairJobs] (
        [Id] int NOT NULL IDENTITY,
        [JobNo] nvarchar(30) NOT NULL,
        [Status] nvarchar(40) NOT NULL,
        [CustomerName] nvarchar(200) NULL,
        [SerialNumber] nvarchar(40) NULL,
        [PrinterModel] nvarchar(100) NULL,
        [FaultDescription] nvarchar(max) NULL,
        [QuoteAmount] decimal(12,2) NULL,
        [ZohoInvoiceNumber] nvarchar(50) NULL,
        [CreatedAt] datetime NOT NULL,
        [InvoicedAt] datetime NULL,
        CONSTRAINT [PK_RepairJobs] PRIMARY KEY ([Id])
    );
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725100454_AddDashboardTables'
)
BEGIN
    CREATE TABLE [SupportTickets] (
        [Id] int NOT NULL IDENTITY,
        [TicketNo] nvarchar(30) NOT NULL,
        [Status] nvarchar(30) NOT NULL,
        [CustomerName] nvarchar(200) NULL,
        [SerialNumber] nvarchar(40) NULL,
        [Subject] nvarchar(max) NULL,
        [SlaBreached] bit NOT NULL,
        [CreatedAt] datetime NOT NULL,
        [ResolvedAt] datetime NULL,
        [ResolutionHours] float NULL,
        CONSTRAINT [PK_SupportTickets] PRIMARY KEY ([Id])
    );
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725100454_AddDashboardTables'
)
BEGIN
    CREATE TABLE [UserUiPreferences] (
        [Id] int NOT NULL IDENTITY,
        [UserName] nvarchar(100) NOT NULL,
        [DarkMode] bit NOT NULL,
        [DashboardView] nvarchar(20) NOT NULL,
        [UpdatedAt] datetime NOT NULL,
        CONSTRAINT [PK_UserUiPreferences] PRIMARY KEY ([Id])
    );
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725100454_AddDashboardTables'
)
BEGIN
    CREATE INDEX [IX_ActivityLogs_CreatedAt] ON [ActivityLogs] ([CreatedAt]);
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725100454_AddDashboardTables'
)
BEGIN
    CREATE INDEX [IX_PartMovements_MovedAt] ON [PartMovements] ([MovedAt]);
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725100454_AddDashboardTables'
)
BEGIN
    CREATE UNIQUE INDEX [IX_RepairJobs_JobNo] ON [RepairJobs] ([JobNo]);
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725100454_AddDashboardTables'
)
BEGIN
    CREATE UNIQUE INDEX [IX_SupportTickets_TicketNo] ON [SupportTickets] ([TicketNo]);
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725100454_AddDashboardTables'
)
BEGIN
    CREATE UNIQUE INDEX [IX_UserUiPreferences_UserName] ON [UserUiPreferences] ([UserName]);
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725100454_AddDashboardTables'
)
BEGIN
    INSERT INTO [__EFMigrationsHistory] ([MigrationId], [ProductVersion])
    VALUES (N'20260725100454_AddDashboardTables', N'8.0.4');
END;
GO

COMMIT;
GO

BEGIN TRANSACTION;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725115438_CarePackLineSetsAndFlexibleSerials'
)
BEGIN
    DROP INDEX [IX_CarePackBatches_InvoiceNumber] ON [CarePackBatches];
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725115438_CarePackLineSetsAndFlexibleSerials'
)
BEGIN
    ALTER TABLE [CarePackBatches] ADD [LineSetIndex] int NOT NULL DEFAULT 1;
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725115438_CarePackLineSetsAndFlexibleSerials'
)
BEGIN
    ALTER TABLE [CarePackBatches] ADD [PrinterItemName] nvarchar(200) NULL;
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725115438_CarePackLineSetsAndFlexibleSerials'
)
BEGIN
    CREATE UNIQUE INDEX [IX_CarePackBatches_InvoiceNumber_LineSetIndex] ON [CarePackBatches] ([InvoiceNumber], [LineSetIndex]);
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725115438_CarePackLineSetsAndFlexibleSerials'
)
BEGIN
    INSERT INTO [__EFMigrationsHistory] ([MigrationId], [ProductVersion])
    VALUES (N'20260725115438_CarePackLineSetsAndFlexibleSerials', N'8.0.4');
END;
GO

COMMIT;
GO

BEGIN TRANSACTION;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725115558_SerialNumberNoLengthGate'
)
BEGIN
    DROP INDEX [IX_CarePackDevices_SerialNumber] ON [CarePackDevices];
    DECLARE @var0 sysname;
    SELECT @var0 = [d].[name]
    FROM [sys].[default_constraints] [d]
    INNER JOIN [sys].[columns] [c] ON [d].[parent_column_id] = [c].[column_id] AND [d].[parent_object_id] = [c].[object_id]
    WHERE ([d].[parent_object_id] = OBJECT_ID(N'[CarePackDevices]') AND [c].[name] = N'SerialNumber');
    IF @var0 IS NOT NULL EXEC(N'ALTER TABLE [CarePackDevices] DROP CONSTRAINT [' + @var0 + '];');
    ALTER TABLE [CarePackDevices] ALTER COLUMN [SerialNumber] nvarchar(100) NOT NULL;
    CREATE INDEX [IX_CarePackDevices_SerialNumber] ON [CarePackDevices] ([SerialNumber]);
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260725115558_SerialNumberNoLengthGate'
)
BEGIN
    INSERT INTO [__EFMigrationsHistory] ([MigrationId], [ProductVersion])
    VALUES (N'20260725115558_SerialNumberNoLengthGate', N'8.0.4');
END;
GO

COMMIT;
GO


