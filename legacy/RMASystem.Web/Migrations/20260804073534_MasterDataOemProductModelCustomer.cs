using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace RMASystem.Migrations
{
    /// <inheritdoc />
    public partial class MasterDataOemProductModelCustomer : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<int>(
                name: "CustomerId",
                table: "RMATickets",
                type: "int",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "CustomerState",
                table: "RMATickets",
                type: "nvarchar(100)",
                maxLength: 100,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "ProductModelId",
                table: "RMATickets",
                type: "int",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "ProductModelId",
                table: "CarePackDevices",
                type: "int",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "CarePackTypeId",
                table: "CarePackBatches",
                type: "int",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "CustomerId",
                table: "CarePackBatches",
                type: "int",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "CustomerState",
                table: "CarePackBatches",
                type: "nvarchar(100)",
                maxLength: 100,
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "OemVendorId",
                table: "CarePackBatches",
                type: "int",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "ProductId",
                table: "CarePackBatches",
                type: "int",
                nullable: true);

            migrationBuilder.AddColumn<int>(
                name: "ProductModelId",
                table: "CarePackBatches",
                type: "int",
                nullable: true);

            migrationBuilder.CreateTable(
                name: "CarePackTypeMasters",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    CompanyId = table.Column<int>(type: "int", nullable: false),
                    Name = table.Column<string>(type: "nvarchar(80)", maxLength: 80, nullable: false),
                    DurationYears = table.Column<int>(type: "int", nullable: false),
                    IsActive = table.Column<bool>(type: "bit", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_CarePackTypeMasters", x => x.Id);
                    table.ForeignKey(
                        name: "FK_CarePackTypeMasters_Companies_CompanyId",
                        column: x => x.CompanyId,
                        principalTable: "Companies",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "Customers",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    CompanyId = table.Column<int>(type: "int", nullable: false),
                    Code = table.Column<string>(type: "nvarchar(40)", maxLength: 40, nullable: false),
                    Name = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    State = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true),
                    City = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true),
                    Address = table.Column<string>(type: "nvarchar(max)", nullable: true),
                    Postal = table.Column<string>(type: "nvarchar(20)", maxLength: 20, nullable: true),
                    Country = table.Column<string>(type: "nvarchar(100)", maxLength: 100, nullable: true),
                    ContactName = table.Column<string>(type: "nvarchar(150)", maxLength: 150, nullable: true),
                    Email = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: true),
                    Phone = table.Column<string>(type: "nvarchar(50)", maxLength: 50, nullable: true),
                    Gstin = table.Column<string>(type: "nvarchar(20)", maxLength: 20, nullable: true),
                    IsActive = table.Column<bool>(type: "bit", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Customers", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Customers_Companies_CompanyId",
                        column: x => x.CompanyId,
                        principalTable: "Companies",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "OemVendors",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    CompanyId = table.Column<int>(type: "int", nullable: false),
                    Code = table.Column<string>(type: "nvarchar(40)", maxLength: 40, nullable: false),
                    Name = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    IsActive = table.Column<bool>(type: "bit", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_OemVendors", x => x.Id);
                    table.ForeignKey(
                        name: "FK_OemVendors_Companies_CompanyId",
                        column: x => x.CompanyId,
                        principalTable: "Companies",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "Products",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    CompanyId = table.Column<int>(type: "int", nullable: false),
                    OemVendorId = table.Column<int>(type: "int", nullable: false),
                    Code = table.Column<string>(type: "nvarchar(40)", maxLength: 40, nullable: false),
                    Name = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    IsActive = table.Column<bool>(type: "bit", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_Products", x => x.Id);
                    table.ForeignKey(
                        name: "FK_Products_Companies_CompanyId",
                        column: x => x.CompanyId,
                        principalTable: "Companies",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_Products_OemVendors_OemVendorId",
                        column: x => x.OemVendorId,
                        principalTable: "OemVendors",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateTable(
                name: "ProductModels",
                columns: table => new
                {
                    Id = table.Column<int>(type: "int", nullable: false)
                        .Annotation("SqlServer:Identity", "1, 1"),
                    CompanyId = table.Column<int>(type: "int", nullable: false),
                    ProductId = table.Column<int>(type: "int", nullable: false),
                    Code = table.Column<string>(type: "nvarchar(40)", maxLength: 40, nullable: false),
                    Name = table.Column<string>(type: "nvarchar(200)", maxLength: 200, nullable: false),
                    IsActive = table.Column<bool>(type: "bit", nullable: false),
                    CreatedAt = table.Column<DateTime>(type: "datetime", nullable: false)
                },
                constraints: table =>
                {
                    table.PrimaryKey("PK_ProductModels", x => x.Id);
                    table.ForeignKey(
                        name: "FK_ProductModels_Companies_CompanyId",
                        column: x => x.CompanyId,
                        principalTable: "Companies",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                    table.ForeignKey(
                        name: "FK_ProductModels_Products_ProductId",
                        column: x => x.ProductId,
                        principalTable: "Products",
                        principalColumn: "Id",
                        onDelete: ReferentialAction.Restrict);
                });

            migrationBuilder.CreateIndex(
                name: "IX_RMATickets_CustomerId",
                table: "RMATickets",
                column: "CustomerId");

            migrationBuilder.CreateIndex(
                name: "IX_RMATickets_ProductModelId",
                table: "RMATickets",
                column: "ProductModelId");

            migrationBuilder.CreateIndex(
                name: "IX_CarePackDevices_ProductModelId",
                table: "CarePackDevices",
                column: "ProductModelId");

            migrationBuilder.CreateIndex(
                name: "IX_CarePackBatches_CarePackTypeId",
                table: "CarePackBatches",
                column: "CarePackTypeId");

            migrationBuilder.CreateIndex(
                name: "IX_CarePackBatches_CustomerId",
                table: "CarePackBatches",
                column: "CustomerId");

            migrationBuilder.CreateIndex(
                name: "IX_CarePackBatches_OemVendorId",
                table: "CarePackBatches",
                column: "OemVendorId");

            migrationBuilder.CreateIndex(
                name: "IX_CarePackBatches_ProductId",
                table: "CarePackBatches",
                column: "ProductId");

            migrationBuilder.CreateIndex(
                name: "IX_CarePackBatches_ProductModelId",
                table: "CarePackBatches",
                column: "ProductModelId");

            migrationBuilder.CreateIndex(
                name: "IX_CarePackTypeMasters_CompanyId_Name",
                table: "CarePackTypeMasters",
                columns: new[] { "CompanyId", "Name" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Customers_CompanyId_Code",
                table: "Customers",
                columns: new[] { "CompanyId", "Code" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_OemVendors_CompanyId_Code",
                table: "OemVendors",
                columns: new[] { "CompanyId", "Code" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_ProductModels_CompanyId",
                table: "ProductModels",
                column: "CompanyId");

            migrationBuilder.CreateIndex(
                name: "IX_ProductModels_ProductId_Code",
                table: "ProductModels",
                columns: new[] { "ProductId", "Code" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Products_CompanyId_Code",
                table: "Products",
                columns: new[] { "CompanyId", "Code" },
                unique: true);

            migrationBuilder.CreateIndex(
                name: "IX_Products_OemVendorId",
                table: "Products",
                column: "OemVendorId");

            migrationBuilder.AddForeignKey(
                name: "FK_CarePackBatches_CarePackTypeMasters_CarePackTypeId",
                table: "CarePackBatches",
                column: "CarePackTypeId",
                principalTable: "CarePackTypeMasters",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);

            migrationBuilder.AddForeignKey(
                name: "FK_CarePackBatches_Customers_CustomerId",
                table: "CarePackBatches",
                column: "CustomerId",
                principalTable: "Customers",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);

            migrationBuilder.AddForeignKey(
                name: "FK_CarePackBatches_OemVendors_OemVendorId",
                table: "CarePackBatches",
                column: "OemVendorId",
                principalTable: "OemVendors",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);

            migrationBuilder.AddForeignKey(
                name: "FK_CarePackBatches_ProductModels_ProductModelId",
                table: "CarePackBatches",
                column: "ProductModelId",
                principalTable: "ProductModels",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);

            migrationBuilder.AddForeignKey(
                name: "FK_CarePackBatches_Products_ProductId",
                table: "CarePackBatches",
                column: "ProductId",
                principalTable: "Products",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);

            migrationBuilder.AddForeignKey(
                name: "FK_CarePackDevices_ProductModels_ProductModelId",
                table: "CarePackDevices",
                column: "ProductModelId",
                principalTable: "ProductModels",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);

            migrationBuilder.AddForeignKey(
                name: "FK_RMATickets_Customers_CustomerId",
                table: "RMATickets",
                column: "CustomerId",
                principalTable: "Customers",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);

            migrationBuilder.AddForeignKey(
                name: "FK_RMATickets_ProductModels_ProductModelId",
                table: "RMATickets",
                column: "ProductModelId",
                principalTable: "ProductModels",
                principalColumn: "Id",
                onDelete: ReferentialAction.SetNull);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropForeignKey(
                name: "FK_CarePackBatches_CarePackTypeMasters_CarePackTypeId",
                table: "CarePackBatches");

            migrationBuilder.DropForeignKey(
                name: "FK_CarePackBatches_Customers_CustomerId",
                table: "CarePackBatches");

            migrationBuilder.DropForeignKey(
                name: "FK_CarePackBatches_OemVendors_OemVendorId",
                table: "CarePackBatches");

            migrationBuilder.DropForeignKey(
                name: "FK_CarePackBatches_ProductModels_ProductModelId",
                table: "CarePackBatches");

            migrationBuilder.DropForeignKey(
                name: "FK_CarePackBatches_Products_ProductId",
                table: "CarePackBatches");

            migrationBuilder.DropForeignKey(
                name: "FK_CarePackDevices_ProductModels_ProductModelId",
                table: "CarePackDevices");

            migrationBuilder.DropForeignKey(
                name: "FK_RMATickets_Customers_CustomerId",
                table: "RMATickets");

            migrationBuilder.DropForeignKey(
                name: "FK_RMATickets_ProductModels_ProductModelId",
                table: "RMATickets");

            migrationBuilder.DropTable(
                name: "CarePackTypeMasters");

            migrationBuilder.DropTable(
                name: "Customers");

            migrationBuilder.DropTable(
                name: "ProductModels");

            migrationBuilder.DropTable(
                name: "Products");

            migrationBuilder.DropTable(
                name: "OemVendors");

            migrationBuilder.DropIndex(
                name: "IX_RMATickets_CustomerId",
                table: "RMATickets");

            migrationBuilder.DropIndex(
                name: "IX_RMATickets_ProductModelId",
                table: "RMATickets");

            migrationBuilder.DropIndex(
                name: "IX_CarePackDevices_ProductModelId",
                table: "CarePackDevices");

            migrationBuilder.DropIndex(
                name: "IX_CarePackBatches_CarePackTypeId",
                table: "CarePackBatches");

            migrationBuilder.DropIndex(
                name: "IX_CarePackBatches_CustomerId",
                table: "CarePackBatches");

            migrationBuilder.DropIndex(
                name: "IX_CarePackBatches_OemVendorId",
                table: "CarePackBatches");

            migrationBuilder.DropIndex(
                name: "IX_CarePackBatches_ProductId",
                table: "CarePackBatches");

            migrationBuilder.DropIndex(
                name: "IX_CarePackBatches_ProductModelId",
                table: "CarePackBatches");

            migrationBuilder.DropColumn(
                name: "CustomerId",
                table: "RMATickets");

            migrationBuilder.DropColumn(
                name: "CustomerState",
                table: "RMATickets");

            migrationBuilder.DropColumn(
                name: "ProductModelId",
                table: "RMATickets");

            migrationBuilder.DropColumn(
                name: "ProductModelId",
                table: "CarePackDevices");

            migrationBuilder.DropColumn(
                name: "CarePackTypeId",
                table: "CarePackBatches");

            migrationBuilder.DropColumn(
                name: "CustomerId",
                table: "CarePackBatches");

            migrationBuilder.DropColumn(
                name: "CustomerState",
                table: "CarePackBatches");

            migrationBuilder.DropColumn(
                name: "OemVendorId",
                table: "CarePackBatches");

            migrationBuilder.DropColumn(
                name: "ProductId",
                table: "CarePackBatches");

            migrationBuilder.DropColumn(
                name: "ProductModelId",
                table: "CarePackBatches");
        }
    }
}
