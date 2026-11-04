using System;
using Microsoft.EntityFrameworkCore.Migrations;

#nullable disable

namespace RMASystem.Migrations
{
    /// <inheritdoc />
    public partial class AddCarePackOemInvoicePdfAndVerification : Migration
    {
        /// <inheritdoc />
        protected override void Up(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.AddColumn<string>(
                name: "OemInvoicePdfPath",
                table: "CarePackBatches",
                type: "nvarchar(500)",
                maxLength: 500,
                nullable: true);

            migrationBuilder.AddColumn<bool>(
                name: "VerificationComplete",
                table: "CarePackBatches",
                type: "bit",
                nullable: false,
                defaultValue: false);

            migrationBuilder.AddColumn<DateTime>(
                name: "VerificationCompletedAt",
                table: "CarePackBatches",
                type: "datetime",
                nullable: true);

            migrationBuilder.AddColumn<string>(
                name: "VerificationCompletedBy",
                table: "CarePackBatches",
                type: "nvarchar(100)",
                maxLength: 100,
                nullable: true);
        }

        /// <inheritdoc />
        protected override void Down(MigrationBuilder migrationBuilder)
        {
            migrationBuilder.DropColumn(
                name: "OemInvoicePdfPath",
                table: "CarePackBatches");

            migrationBuilder.DropColumn(
                name: "VerificationComplete",
                table: "CarePackBatches");

            migrationBuilder.DropColumn(
                name: "VerificationCompletedAt",
                table: "CarePackBatches");

            migrationBuilder.DropColumn(
                name: "VerificationCompletedBy",
                table: "CarePackBatches");
        }
    }
}
